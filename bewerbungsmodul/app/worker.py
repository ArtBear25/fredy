"""One durable application queue and one owner of the interactive browser."""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from app.browser import BrowserController
from app.config import Settings
from app.database import Database
from app.email_service import MailMatch, ParsedMail
from app.models import ApplicationStatus, WorkflowDefinition, WorkflowStep
from app.workflow import ManualActionRequired, WorkflowExecutor, WorkflowRejected, screenshot_name


@dataclass(slots=True)
class EmailJob:
    parsed: ParsedMail
    match: MailMatch


class ApplicationWorker:
    def __init__(
        self,
        database: Database,
        browser: BrowserController,
        executor: WorkflowExecutor,
        settings: Settings,
        *,
        callback_token: str | None = None,
    ):
        self.database = database
        self.browser = browser
        self.executor = executor
        self.settings = settings
        self.callback_token = callback_token
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.browser_application_id: int | None = None
        self.current_application_id: int | None = None
        self.last_tick_at = datetime.now(UTC)
        self.last_progress_at = self.last_tick_at

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, name="application-worker", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join()  # finish checkpointing before the database/browser are closed

    def enqueue_email(self, parsed: ParsedMail, match: MailMatch, mailbox: str = "INBOX") -> bool:
        return self.database.queue_mail(
            match.application["id"],
            mailbox,
            parsed.uid,
            {
                "mailbox": mailbox,
                "uid": parsed.uid,
                "trigger_id": match.trigger.id,
                "sender": parsed.sender,
                "subject": parsed.subject,
                "body": parsed.body,
                "link": match.link,
            },
        )

    def _run(self) -> None:
        while not self.stop_event.wait(self.settings.worker_poll_seconds):
            self.last_tick_at = datetime.now(UTC)
            try:
                if self.database.get_setting("paused", False) or self.database.active_recorder():
                    continue
                application = self.database.claim_next_application()
                if application:
                    self.current_application_id = application["id"]
                    self.last_progress_at = datetime.now(UTC)
                    try:
                        self._process_application(application)
                    finally:
                        self.current_application_id = None
                        self.last_progress_at = datetime.now(UTC)
            except Exception as error:
                self.database.audit("worker_failed", {"error": str(error)})

    def runtime_snapshot(self, waiting_count: int = 0, waiting_age_seconds: float = 0.0) -> dict[str, Any]:
        """Small in-memory health view; no second persistence layer is needed for worker liveness."""
        now = datetime.now(UTC)
        tick_age = max(0.0, (now - self.last_tick_at).total_seconds())
        progress_age = max(0.0, (now - self.last_progress_at).total_seconds())
        threshold = max(90.0, float(self.settings.worker_poll_seconds) * 30)
        alive = bool(self.thread and self.thread.is_alive())
        stalled_current = (
            alive
            and self.current_application_id is not None
            and tick_age >= threshold
            and progress_age >= threshold
        )
        stalled_waiting = (
            alive
            and waiting_count > 0
            and self.current_application_id is None
            and progress_age >= threshold
            and waiting_age_seconds >= threshold
        )
        can_reset = self.current_application_id is None
        return {
            "alive": alive,
            "current_application_id": self.current_application_id,
            "waiting_count": waiting_count,
            "last_tick_at": self.last_tick_at.isoformat(),
            "last_progress_at": self.last_progress_at.isoformat(),
            "tick_age_seconds": tick_age,
            "progress_age_seconds": progress_age,
            "waiting_age_seconds": waiting_age_seconds,
            "stalled": stalled_current or stalled_waiting,
            "can_reset": can_reset,
        }

    def reset_runtime(self) -> None:
        """Drop only safe volatile browser state; persisted applications and checkpoints stay untouched."""
        current_id = self.current_application_id
        if current_id is not None:
            raise ValueError(
                "Eine Bewerbung wird gerade verarbeitet und kann nicht sicher zurückgesetzt werden"
            )
        self.browser_application_id = None
        if self.browser is not None:
            self.browser.quit()
        self.last_progress_at = datetime.now(UTC)
        self.database.audit(
            "worker_reset",
            {"reason": "manual_runtime_reset", "application_id": current_id},
            current_id,
        )

    def report_status(self, application_id: int, status: str, detail: str = "") -> None:
        """Expose the existing Fredy callback for explicit user actions such as cancel."""
        self._notify_fredy(application_id, status, detail)

    def _process_application(self, application: dict[str, Any]) -> None:
        application_id = application["id"]
        attempt_id = self.database.start_attempt(
            application_id, application["mode"] + "/" + application["phase"]
        )
        workflow = None
        try:
            listing = json.loads(application["listing_json"])
            has_direct_route = bool(listing.get("officialProvider") and listing.get("providerLink"))
            application_url = listing["providerLink"] if has_direct_route else listing["url"]
            if application.get("workflow_snapshot"):
                workflow = WorkflowDefinition.model_validate_json(application["workflow_snapshot"])
            elif application.get("workflow_id"):
                workflow = self.database.get_workflow(
                    application["workflow_id"], application["workflow_version"]
                )
            else:
                workflow = self.database.active_workflow(application["provider"])
            if not workflow:
                self._finish(
                    application_id,
                    attempt_id,
                    ApplicationStatus.UNSUPPORTED,
                    "Kein eindeutig passender aktiver Workflow",
                )
                return
            self.database.pin_application(application_id, workflow)
            application = self.database.get_application(application_id)
            current = self.database.get_workflow(workflow.id, workflow.version)
            if not current or current.definition_hash() != workflow.definition_hash():
                raise ManualActionRequired("Die geprüfte Definition wurde geändert. Einen neuen Test starten")
            if application["mode"] == "application" and not current.enabled:
                raise ManualActionRequired("Die zugeordnete Workflow-Version ist deaktiviert")
            execution_listing = dict(listing)
            execution_listing["url"] = application_url
            context = {
                "listing": execution_listing,
                "profile": json.loads(application["profile_json"]),
                "email": {},
            }
            steps = workflow.steps
            execution_workflow = workflow
            email_phase = application["phase"].startswith("email:")
            if email_phase:
                context["email"] = json.loads(application["email_json"])
                trigger = next(
                    (item for item in workflow.email_triggers if item.id == application["phase"][6:]), None
                )
                if trigger is None:
                    raise ManualActionRequired("Gespeicherte E-Mail-Fortsetzung fehlt")
                steps = trigger.continuation_steps
                email_link_host = urlparse(str(context["email"].get("link") or "")).hostname
                email_domains = list(workflow.allowed_domains)
                for domain in workflow.allowed_domains:
                    if domain.startswith("www."):
                        email_domains.append(domain[4:])
                if email_link_host:
                    email_domains.append(email_link_host.casefold())
                execution_workflow = workflow.model_copy(
                    update={"allowed_domains": list(dict.fromkeys(email_domains))}
                )
            start_index = application["step_index"]
            if application["submission_state"] == "intent":
                raise ManualActionRequired(
                    "Unklarer Versandstatus. Vor jedem weiteren Versuch manuell prüfen"
                )
            with self.browser.exclusive():
                if self.database.active_recorder():
                    self._finish(
                        application_id,
                        attempt_id,
                        ApplicationStatus.RECEIVED,
                        "Wartet auf das Ende der Aufnahme",
                    )
                    return
                if self.browser_application_id != application_id:
                    if start_index and application["submission_state"] in {"sent", "verified"}:
                        raise ManualActionRequired(
                            "Der Browserzustand nach dem Versand ist nicht mehr vorhanden. "
                            "Erfolg extern prüfen"
                        )
                    # Only reviewed preparation can be rebuilt in a fresh context.
                    start_index = 0
                    self.browser_application_id = application_id
                    self.database.checkpoint(application_id, 0)
                if start_index == 0:
                    self.browser.reset_tabs()
                else:
                    saved_state = json.loads(application["checkpoint_json"] or "null")
                    if not saved_state or self.browser.state() != saved_state:
                        if application["submission_state"] == "none":
                            start_index = 0
                            self.browser.reset_tabs()
                            self.database.checkpoint(application_id, 0)
                        elif any(
                            step.action not in {"assert", "wait", "email_wait"}
                            for step in steps[start_index:]
                        ):
                            raise ManualActionRequired(
                                "Browserzustand verändert. Versand und Fortsetzungspunkt manuell prüfen"
                            )
                self.database.update_application(application_id, ApplicationStatus.RUNNING, workflow=workflow)
                self._notify_fredy(application_id, "running")

                def cancelled():
                    latest = self.database.get_workflow(workflow.id, workflow.version)
                    return (
                        self.stop_event.is_set()
                        or self.database.get_setting("paused", False)
                        or (application["mode"] == "application" and (latest is None or not latest.enabled))
                    )

                result = self.executor.execute(
                    execution_workflow,
                    context,
                    dry_run=application["mode"] == "dry-run",
                    steps=steps[start_index:],
                    audit_callback=self._auditor(application_id, steps),
                    cancel_requested=cancelled,
                )
            detail = result.detail
            if result.stopped_before_submit and application["mode"] == "dry-run":
                status = ApplicationStatus.DRY_RUN_PASSED
            elif result.email_pending or (result.completed and workflow.email_triggers and not email_phase):
                status = ApplicationStatus.EMAIL_PENDING
                detail = "Warte auf Bestätigungsmail"
            elif result.completed:
                status = ApplicationStatus.COMPLETED
            else:
                raise ManualActionRequired("Der Ablauf hat keinen geprüften Endzustand erreicht")
            if status in {ApplicationStatus.COMPLETED, ApplicationStatus.EMAIL_PENDING}:
                self.database.checkpoint(application_id, len(steps), "verified")
            self._finish(application_id, attempt_id, status, detail)
            self.database.record_check(application_id)
            if application["email_json"]:
                mail = json.loads(application["email_json"])
                self.database.update_mail_match(mail["mailbox"], mail["uid"], application_id, "processed")
        except WorkflowRejected as error:
            self._finish(application_id, attempt_id, ApplicationStatus.RULE_REJECTED, str(error))
        except ManualActionRequired as error:
            self._finish(application_id, attempt_id, ApplicationStatus.MANUAL_ACTION, str(error))
        except Exception as error:
            self._finish(application_id, attempt_id, ApplicationStatus.FAILED, str(error))
        finally:
            if self.browser_application_id == application_id:
                self.browser_application_id = None

    def _process_email(self, job: EmailJob) -> None:
        # Compatibility for callers; queueing itself is transactional and durable.
        if self.enqueue_email(job.parsed, job.match):
            application = self.database.claim_next_application(job.match.application["id"])
            if application:
                self._process_application(application)

    def _auditor(self, application_id: int, all_steps: list[WorkflowStep]):
        def record(step: WorkflowStep, result: str, error: str | None) -> None:
            self.last_progress_at = datetime.now(UTC)
            index = next(i for i, item in enumerate(all_steps) if item.id == step.id)
            try:
                browser_state = self.browser.state()
            except Exception:
                browser_state = None
            if result == "submission_intent":
                self.database.checkpoint(application_id, index, "intent", browser_state)
            elif result == "submission_sent":
                self.database.checkpoint(application_id, index + 1, "sent", browser_state)
            elif result in {"completed", "manual_action_after"}:
                self.database.checkpoint(application_id, index + 1, browser_state=browser_state)
            path = self.settings.screenshots_dir / screenshot_name(application_id, step.id)
            try:
                screenshot = self.browser.screenshot(path)
            except Exception:
                screenshot = None
            self.database.audit(
                "workflow_step",
                {"step_id": step.id, "action": step.action, "result": result, "error": error},
                application_id,
                screenshot,
            )

        return record

    def _finish(self, application_id: int, attempt_id: int, status: ApplicationStatus, detail: str) -> None:
        self.database.update_application(application_id, status, detail)
        self.database.finish_attempt(attempt_id, status, detail)
        self.database.audit("application_status", {"status": status, "detail": detail}, application_id)
        callback_status = {
            ApplicationStatus.COMPLETED: "applied",
            ApplicationStatus.EMAIL_PENDING: "running",
            ApplicationStatus.FAILED: "failed",
            ApplicationStatus.MANUAL_ACTION: "failed",
            ApplicationStatus.UNSUPPORTED: "failed",
            ApplicationStatus.RULE_REJECTED: "failed",
            ApplicationStatus.CANCELLED: "cancelled",
        }.get(status)
        if callback_status:
            self._notify_fredy(application_id, callback_status, detail)

    def _notify_fredy(self, application_id: int, status: str, detail: str = "") -> None:
        """Report progress asynchronously so one slow callback never delays the next application."""
        if not self.callback_token:
            return
        application = self.database.get_application(application_id)
        if not application or application.get("mode") != "application":
            return
        try:
            listing = json.loads(application["listing_json"])
        except (TypeError, json.JSONDecodeError):
            return
        callback_url = listing.get("callbackUrl")
        if not callback_url:
            return
        payload = json.dumps(
            {
                "status": status,
                "detail": detail,
                "applicationId": application_id,
                "trigger": listing.get("applicationTrigger"),
            }
        ).encode("utf-8")
        threading.Thread(
            target=self._send_fredy_callback,
            args=(application_id, status, callback_url, payload),
            name=f"fredy-callback-{application_id}",
            daemon=True,
        ).start()

    def _send_fredy_callback(
        self, application_id: int, status: str, callback_url: str, payload: bytes
    ) -> None:
        request = Request(
            callback_url,
            data=payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.callback_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=2) as response:  # noqa: S310 - authenticated Fredy callback URL
                response.read(1)
        except Exception as error:
            try:
                self.database.audit(
                    "fredy_callback_failed",
                    {"status": status, "url": callback_url, "error": str(error)},
                    application_id,
                )
            except Exception:
                # Shutdown may close SQLite while the detached callback is still finishing.
                pass
