"""Single browser worker for applications and email continuations."""

from __future__ import annotations

import json
import queue
import threading
from dataclasses import dataclass
from typing import Any

from app.browser import BrowserController
from app.config import Settings
from app.database import Database
from app.email_service import MailMatch, ParsedMail
from app.models import ApplicationStatus, WorkflowStep
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
    ):
        self.database = database
        self.browser = browser
        self.executor = executor
        self.settings = settings
        self.stop_event = threading.Event()
        self.email_jobs: queue.Queue[EmailJob] = queue.Queue()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, name="application-worker", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)

    def enqueue_email(self, parsed: ParsedMail, match: MailMatch) -> None:
        self.email_jobs.put(EmailJob(parsed, match))

    def _run(self) -> None:
        while not self.stop_event.wait(self.settings.worker_poll_seconds):
            if self.database.active_recorder():
                continue
            try:
                email_job = self.email_jobs.get_nowait()
            except queue.Empty:
                email_job = None
            if email_job:
                self._process_email(email_job)
                continue
            application = self.database.claim_next_application()
            if application:
                self._process_application(application)

    def _process_application(self, application: dict[str, Any]) -> None:
        attempt_id = self.database.start_attempt(application["id"], "application")
        listing = json.loads(application["listing_json"])
        workflow = self.database.active_workflow(application["provider"], listing["url"])
        if not workflow:
            self.database.update_application(
                application["id"], ApplicationStatus.UNSUPPORTED, "No active workflow matches"
            )
            self.database.finish_attempt(attempt_id, ApplicationStatus.UNSUPPORTED)
            return
        self.database.update_application(application["id"], ApplicationStatus.RUNNING, workflow=workflow)
        context = self._context(listing)
        start_index = int(application.get("step_index") or 0)
        try:
            with self.browser.exclusive():
                result = self.executor.execute(
                    workflow,
                    context,
                    steps=workflow.steps[start_index:],
                    audit_callback=self._auditor(application["id"], workflow.steps),
                )
            status = ApplicationStatus.EMAIL_PENDING if result.email_pending else ApplicationStatus.COMPLETED
            self.database.update_application(application["id"], status, result.detail, workflow)
            self.database.finish_attempt(attempt_id, status, result.detail)
        except WorkflowRejected as error:
            self.database.update_application(
                application["id"], ApplicationStatus.RULE_REJECTED, str(error), workflow
            )
            self.database.finish_attempt(attempt_id, ApplicationStatus.RULE_REJECTED, str(error))
        except ManualActionRequired as error:
            self._failure(application["id"], ApplicationStatus.MANUAL_ACTION, str(error))
            self.database.finish_attempt(attempt_id, ApplicationStatus.MANUAL_ACTION, str(error))
        except Exception as error:  # keep the worker alive and expose the exact failure in the audit log
            self._failure(application["id"], ApplicationStatus.FAILED, str(error))
            self.database.finish_attempt(attempt_id, ApplicationStatus.FAILED, str(error))

    def _process_email(self, job: EmailJob) -> None:
        application = job.match.application
        attempt_id = self.database.start_attempt(application["id"], "email")
        listing = json.loads(application["listing_json"])
        context = self._context(listing)
        context["email"] = {
            "sender": job.parsed.sender,
            "subject": job.parsed.subject,
            "body": job.parsed.body,
            "link": job.match.link,
        }
        try:
            with self.browser.exclusive():
                result = self.executor.execute(
                    job.match.workflow,
                    context,
                    steps=job.match.trigger.continuation_steps,
                    audit_callback=self._auditor(application["id"], job.match.trigger.continuation_steps),
                )
            status = ApplicationStatus.COMPLETED if result.completed else ApplicationStatus.CONFIRMED
            self.database.update_application(application["id"], status, result.detail, job.match.workflow)
            self.database.update_mail_match("INBOX", job.parsed.uid, application["id"], "processed")
            self.database.finish_attempt(attempt_id, status, result.detail)
        except ManualActionRequired as error:
            self.database.update_mail_match("INBOX", job.parsed.uid, application["id"], "manual_action")
            self._failure(application["id"], ApplicationStatus.MANUAL_ACTION, str(error))
            self.database.finish_attempt(attempt_id, ApplicationStatus.MANUAL_ACTION, str(error))
        except Exception as error:
            self.database.update_mail_match("INBOX", job.parsed.uid, application["id"], "failed")
            self._failure(application["id"], ApplicationStatus.FAILED, str(error))
            self.database.finish_attempt(attempt_id, ApplicationStatus.FAILED, str(error))

    def _context(self, listing: dict[str, Any]) -> dict[str, Any]:
        return {
            "listing": listing,
            "profile": self.database.get_profile().model_dump(mode="json"),
            "email": {},
        }

    def _auditor(self, application_id: int, all_steps: list[WorkflowStep]):
        def record(step: WorkflowStep, result: str, error: str | None) -> None:
            path = self.settings.screenshots_dir / screenshot_name(application_id, step.id)
            screenshot = None
            try:
                screenshot = self.browser.screenshot(path)
            except Exception:
                pass
            self.database.audit(
                "workflow_step",
                {"step_id": step.id, "action": step.action, "result": result, "error": error},
                application_id,
                screenshot,
            )
            if result in {"completed", "manual_action_after"}:
                index = next((i for i, item in enumerate(all_steps) if item.id == step.id), -1)
                if index >= 0:
                    self.database.update_step_index(application_id, index + 1)

        return record

    def _failure(self, application_id: int, status: ApplicationStatus, detail: str) -> None:
        self.database.update_application(application_id, status, detail)
        self.database.audit("application_stopped", {"status": status, "detail": detail}, application_id)
