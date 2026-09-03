"""Local FastAPI dashboard and HTTP API."""

from __future__ import annotations

import asyncio
import hmac
import json
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Annotated, Any

import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.cors import CORSMiddleware

from app.browser import BrowserController
from app.config import Settings, settings
from app.database import Database
from app.email_service import WebDeMailbox, correlate_mail
from app.models import (
    ApplicantProfile,
    ApplicationStatus,
    Condition,
    ElementTarget,
    EmailTrigger,
    FredyEvent,
    LocatorCandidate,
    RecorderEvent,
    RuleGroup,
    ValueBinding,
    WorkflowDefinition,
    WorkflowStep,
)
from app.recorder import RecorderService
from app.security import DocumentVault, SecretStore
from app.worker import ApplicationWorker
from app.workflow import ManualActionRequired, WorkflowExecutor, WorkflowRejected

APP_DIR = Path(__file__).resolve().parent


def create_app(
    runtime_settings: Settings | None = None,
    *,
    start_background: bool = True,
    secret_store: SecretStore | None = None,
) -> FastAPI:
    runtime = runtime_settings or settings

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime.ensure_directories()
        database = Database(runtime.database_path)
        secrets = secret_store or SecretStore()
        browser = BrowserController(
            runtime.chrome_profile_dir,
            APP_DIR / "recorder_extension",
        )
        vault = DocumentVault(runtime.vault_dir, runtime.temp_dir, database, secrets)
        executor = WorkflowExecutor(browser, secrets, vault)
        worker = ApplicationWorker(database, browser, executor, runtime)
        recorder = RecorderService(database, browser)
        mailbox = WebDeMailbox(database, secrets)
        _load_bundled_workflows(database)
        app.state.database = database
        app.state.secrets = secrets
        app.state.browser = browser
        app.state.vault = vault
        app.state.executor = executor
        app.state.worker = worker
        app.state.recorder = recorder
        app.state.mailbox = mailbox
        mail_task = None
        if start_background:
            worker.start()
            mail_task = asyncio.create_task(_mail_loop(app, runtime.mail_poll_seconds))
        try:
            yield
        finally:
            if mail_task:
                mail_task.cancel()
                try:
                    await mail_task
                except asyncio.CancelledError:
                    pass
            worker.stop()
            browser.quit()
            database.close()

    app = FastAPI(title="Bewerbungsmodul", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"chrome-extension://.*",
        allow_methods=["POST"],
        allow_headers=["Content-Type"],
    )
    app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
    templates = Jinja2Templates(directory=APP_DIR / "templates")

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        client = request.client.host if request.client else ""
        if client not in {"127.0.0.1", "::1", "testclient"}:
            return JSONResponse({"detail": "Local access only"}, status_code=403)
        return await call_next(request)

    @app.get("/", response_class=HTMLResponse)
    async def dashboard(request: Request):
        db = _db(request)
        return templates.TemplateResponse(
            request,
            "dashboard.html",
            {
                "counts": db.application_counts(),
                "applications": db.recent_applications(50),
                "workflows": db.list_workflows(),
                "documents": db.list_documents(),
                "profile": db.get_profile(),
                "mails": db.recent_mail_messages(20),
                "recorder": db.active_recorder(),
                "fredy_token": request.app.state.secrets.get_or_create("fredy_webhook_token"),
                "mail_configured": request.app.state.mailbox.configured(),
                "message": request.query_params.get("message"),
            },
        )

    @app.get("/workflows/{workflow_id}/{version}", response_class=HTMLResponse)
    async def workflow_detail(request: Request, workflow_id: str, version: int):
        workflow = _require_workflow(_db(request), workflow_id, version)
        return templates.TemplateResponse(
            request,
            "workflow.html",
            {
                "workflow": workflow,
                "mails": _db(request).recent_mail_messages(50),
                "recorder": _db(request).active_recorder(),
                "documents": _db(request).list_documents(),
            },
        )

    @app.get("/applications/{application_id}", response_class=HTMLResponse)
    async def application_detail(request: Request, application_id: int):
        application = _db(request).get_application(application_id)
        if not application:
            raise HTTPException(404, "Application not found")
        events = _db(request).audit_events(application_id)
        for event in events:
            if event["screenshot_path"]:
                event["screenshot_filename"] = Path(event["screenshot_path"]).name
        return templates.TemplateResponse(
            request,
            "application.html",
            {
                "application": application,
                "listing": json.loads(application["listing_json"]),
                "attempts": _db(request).application_attempts(application_id),
                "events": events,
            },
        )

    @app.get("/screenshots/{filename}")
    async def screenshot(request: Request, filename: str):
        root = runtime.screenshots_dir.resolve()
        path = (root / Path(filename).name).resolve()
        if path.parent != root or not path.is_file():
            raise HTTPException(404, "Screenshot not found")
        return FileResponse(path, media_type="image/png")

    @app.post("/workflows")
    async def create_workflow(
        request: Request,
        name: Annotated[str, Form()],
        provider: Annotated[str, Form()],
        domains: Annotated[str, Form()],
        url_pattern: Annotated[str, Form()],
    ):
        workflow_id = _slug(provider)
        existing = _db(request).get_workflow(workflow_id)
        if existing:
            workflow_id = f"{workflow_id}-{len(_db(request).list_workflows()) + 1}"
        workflow = WorkflowDefinition(
            id=workflow_id,
            name=name.strip(),
            provider=provider.strip(),
            allowed_domains=_csv(domains),
            url_patterns=[url_pattern.strip()],
        )
        _db(request).save_workflow(workflow)
        return _redirect(f"/workflows/{workflow.id}/{workflow.version}", "Workflow angelegt")

    @app.post("/workflows/import")
    async def import_workflow(request: Request, file: Annotated[UploadFile, File()]):
        payload = await file.read()
        workflow = WorkflowDefinition.model_validate_json(payload)
        if workflow.enabled:
            workflow = workflow.model_copy(update={"enabled": False, "lifecycle": "recorded"})
        current = _db(request).get_workflow(workflow.id)
        if current and workflow.version <= current.version:
            workflow = workflow.model_copy(update={"version": current.version + 1})
        _db(request).save_workflow(workflow)
        return _redirect(f"/workflows/{workflow.id}/{workflow.version}", "Workflow importiert")

    @app.get("/workflows/{workflow_id}/{version}/export")
    async def export_workflow(request: Request, workflow_id: str, version: int):
        workflow = _require_workflow(_db(request), workflow_id, version)
        content = workflow.model_dump_json(indent=2)
        return Response(
            content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{workflow.id}-v{version}.json"'},
        )

    @app.post("/workflows/{workflow_id}/{version}/new-version")
    async def new_workflow_version(request: Request, workflow_id: str, version: int):
        workflow = _require_workflow(_db(request), workflow_id, version)
        latest = _db(request).get_workflow(workflow_id)
        new_version = (latest.version if latest else version) + 1
        copy = workflow.model_copy(update={"version": new_version, "enabled": False, "lifecycle": "recorded"})
        _db(request).save_workflow(copy)
        return _redirect(f"/workflows/{workflow_id}/{new_version}", "Neue Version angelegt")

    @app.post("/workflows/{workflow_id}/{version}/json")
    async def update_workflow_json(
        request: Request,
        workflow_id: str,
        version: int,
        definition: Annotated[str, Form()],
    ):
        current = _require_workflow(_db(request), workflow_id, version)
        if current.enabled:
            raise HTTPException(409, "Active workflow versions are immutable")
        workflow = WorkflowDefinition.model_validate_json(definition)
        if workflow.id != workflow_id or workflow.version != version:
            raise HTTPException(400, "Workflow ID and version may not be changed here")
        _db(request).save_workflow(workflow)
        return _redirect(f"/workflows/{workflow_id}/{version}", "Workflow gespeichert")

    @app.post("/workflows/{workflow_id}/{version}/scope")
    async def update_workflow_scope(
        request: Request,
        workflow_id: str,
        version: int,
        domains: Annotated[str, Form()],
        url_patterns: Annotated[str, Form()],
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        updated = workflow.model_copy(
            update={"allowed_domains": _csv(domains), "url_patterns": _csv(url_patterns)}
        )
        updated = WorkflowDefinition.model_validate(updated.model_dump())
        _db(request).save_workflow(updated)
        return _redirect(f"/workflows/{workflow_id}/{version}", "Domains gespeichert")

    @app.post("/workflows/{workflow_id}/{version}/rules")
    async def add_rule(
        request: Request,
        workflow_id: str,
        version: int,
        mode: Annotated[str, Form()],
        field: Annotated[str, Form()],
        operator: Annotated[str, Form()],
        value: Annotated[str, Form()] = "",
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        parsed_value: Any = _form_value(value)
        condition = Condition(field=field, operator=operator, value=parsed_value)
        rules = RuleGroup(mode=mode, conditions=[*workflow.rules.conditions, condition])
        _db(request).save_workflow(workflow.model_copy(update={"rules": rules}))
        return _redirect(f"/workflows/{workflow_id}/{version}", "Regel hinzugefügt")

    @app.post("/workflows/{workflow_id}/{version}/rules/{index}/delete")
    async def delete_rule(request: Request, workflow_id: str, version: int, index: int):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        conditions = list(workflow.rules.conditions)
        if 0 <= index < len(conditions):
            conditions.pop(index)
        _db(request).save_workflow(
            workflow.model_copy(
                update={"rules": workflow.rules.model_copy(update={"conditions": conditions})}
            )
        )
        return _redirect(f"/workflows/{workflow_id}/{version}", "Regel entfernt")

    @app.post("/workflows/{workflow_id}/{version}/rule-groups")
    async def add_rule_group(
        request: Request,
        workflow_id: str,
        version: int,
        mode: Annotated[str, Form()] = "all",
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        groups = [*workflow.rules.groups, RuleGroup(mode=mode)]
        _db(request).save_workflow(
            workflow.model_copy(update={"rules": workflow.rules.model_copy(update={"groups": groups})})
        )
        return _redirect(f"/workflows/{workflow_id}/{version}", "Regelgruppe hinzugefügt")

    @app.post("/workflows/{workflow_id}/{version}/rule-groups/{group_index}/rules")
    async def add_group_rule(
        request: Request,
        workflow_id: str,
        version: int,
        group_index: int,
        field: Annotated[str, Form()],
        operator: Annotated[str, Form()],
        value: Annotated[str, Form()] = "",
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        groups = list(workflow.rules.groups)
        if not 0 <= group_index < len(groups):
            raise HTTPException(404, "Rule group not found")
        group = groups[group_index]
        condition = Condition(field=field, operator=operator, value=_form_value(value))
        groups[group_index] = group.model_copy(update={"conditions": [*group.conditions, condition]})
        _db(request).save_workflow(
            workflow.model_copy(update={"rules": workflow.rules.model_copy(update={"groups": groups})})
        )
        return _redirect(f"/workflows/{workflow_id}/{version}", "Gruppenregel hinzugefügt")

    @app.post("/workflows/{workflow_id}/{version}/steps")
    async def add_manual_step(
        request: Request,
        workflow_id: str,
        version: int,
        action: Annotated[str, Form()],
        locator_strategy: Annotated[str, Form()] = "",
        locator_value: Annotated[str, Form()] = "",
        label: Annotated[str, Form()] = "",
        source: Annotated[str, Form()] = "literal",
        key: Annotated[str, Form()] = "",
        value: Annotated[str, Form()] = "",
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        target = None
        if locator_strategy and locator_value:
            target = ElementTarget(
                label=label,
                candidates=[LocatorCandidate(strategy=locator_strategy, value=locator_value, score=80)],
            )
        binding = ValueBinding(source=source, key=key, value=_form_value(value))
        step = WorkflowStep(
            id=f"manual-{len(workflow.steps) + 1:03d}",
            action=action,
            target=target,
            binding=binding,
        )
        _db(request).save_workflow(workflow.model_copy(update={"steps": [*workflow.steps, step]}))
        return _redirect(f"/workflows/{workflow_id}/{version}", "Schritt hinzugefügt")

    @app.post("/workflows/{workflow_id}/{version}/steps/{step_id}")
    async def update_step(
        request: Request,
        workflow_id: str,
        version: int,
        step_id: str,
        source: Annotated[str, Form()],
        key: Annotated[str, Form()] = "",
        value: Annotated[str, Form()] = "",
        value_format: Annotated[str, Form()] = "none",
        final_submission: Annotated[str | None, Form()] = None,
        optional: Annotated[str | None, Form()] = None,
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        steps = []
        found = False
        for step in workflow.steps:
            if step.id != step_id:
                steps.append(step)
                continue
            found = True
            binding = ValueBinding(source=source, key=key, value=_form_value(value), format=value_format)
            steps.append(
                step.model_copy(
                    update={
                        "binding": binding,
                        "final_submission": final_submission is not None,
                        "optional": optional is not None,
                    }
                )
            )
        if not found:
            raise HTTPException(404, "Step not found")
        _db(request).save_workflow(workflow.model_copy(update={"steps": steps}))
        return _redirect(f"/workflows/{workflow_id}/{version}", "Schritt gespeichert")

    @app.post("/workflows/{workflow_id}/{version}/email-triggers")
    async def add_email_trigger(
        request: Request,
        workflow_id: str,
        version: int,
        sender_pattern: Annotated[str, Form()],
        subject_pattern: Annotated[str, Form()] = ".*",
        body_pattern: Annotated[str, Form()] = "",
        link_pattern: Annotated[str, Form()] = "",
        allowed_domains: Annotated[str, Form()] = "",
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        trigger = EmailTrigger(
            id=f"mail-{len(workflow.email_triggers) + 1}",
            sender_pattern=sender_pattern,
            subject_pattern=subject_pattern,
            body_pattern=body_pattern or None,
            link_pattern=link_pattern or None,
            allowed_domains=_csv(allowed_domains),
        )
        _db(request).save_workflow(
            workflow.model_copy(update={"email_triggers": [*workflow.email_triggers, trigger]})
        )
        return _redirect(f"/workflows/{workflow_id}/{version}", "E-Mail-Regel hinzugefügt")

    @app.post("/workflows/{workflow_id}/{version}/record")
    async def start_recorder(
        request: Request,
        workflow_id: str,
        version: int,
        example_url: Annotated[str, Form()],
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        try:
            session_id = request.app.state.recorder.start(workflow, example_url)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        return _redirect(f"/workflows/{workflow_id}/{version}", f"Recorder läuft mit Sitzung {session_id}")

    @app.post("/recorder/{session_id}/stop")
    async def stop_recorder(request: Request, session_id: str):
        workflow = request.app.state.recorder.stop(session_id)
        return _redirect(f"/workflows/{workflow.id}/{workflow.version}", "Aufzeichnung übernommen")

    @app.post("/workflows/{workflow_id}/{version}/email/{trigger_id}/record/{uid}")
    async def record_email_continuation(
        request: Request, workflow_id: str, version: int, trigger_id: str, uid: int
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        trigger = next((item for item in workflow.email_triggers if item.id == trigger_id), None)
        message = next((item for item in _db(request).recent_mail_messages(500) if item["uid"] == uid), None)
        if not trigger or not message:
            raise HTTPException(404, "Mail trigger or message not found")
        links = json.loads(message["links_json"])
        from app.email_service import _matching_link

        link = _matching_link(links, trigger, workflow)
        if not link:
            raise HTTPException(409, "Mail contains no single allowed matching link")
        session_id = request.app.state.recorder.start(workflow, link, mode="email", trigger_id=trigger_id)
        return _redirect(f"/workflows/{workflow_id}/{version}", f"E-Mail-Recorder läuft mit {session_id}")

    @app.post("/workflows/{workflow_id}/{version}/dry-run")
    async def dry_run(
        request: Request,
        workflow_id: str,
        version: int,
        example_url: Annotated[str, Form()],
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        listing = {"id": "dry-run", "url": example_url, "title": "Dry Run"}
        context = {
            "listing": listing,
            "profile": _db(request).get_profile().model_dump(mode="json"),
            "email": {},
        }
        try:
            with request.app.state.browser.exclusive():
                result = request.app.state.executor.execute(workflow, context, dry_run=True)
        except (ManualActionRequired, WorkflowRejected) as error:
            return _redirect(f"/workflows/{workflow_id}/{version}", f"Dry-Run gestoppt — {error}")
        updated = workflow.model_copy(update={"lifecycle": "dry_run_passed"})
        _db(request).save_workflow(updated)
        return _redirect(f"/workflows/{workflow_id}/{version}", result.detail or "Dry-Run bestanden")

    @app.post("/workflows/{workflow_id}/{version}/live-test")
    async def live_test(
        request: Request,
        workflow_id: str,
        version: int,
        example_url: Annotated[str, Form()],
        confirm: Annotated[str | None, Form()] = None,
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        if workflow.lifecycle != "dry_run_passed" or confirm != "yes":
            raise HTTPException(409, "Dry run and explicit confirmation are required")
        listing = {"id": "live-test", "url": example_url, "title": "Live Test"}
        context = {
            "listing": listing,
            "profile": _db(request).get_profile().model_dump(mode="json"),
            "email": {},
        }
        with request.app.state.browser.exclusive():
            result = request.app.state.executor.execute(workflow, context)
        if not (result.completed or result.email_pending):
            raise HTTPException(409, "Live test did not reach a valid end state")
        _db(request).save_workflow(workflow.model_copy(update={"lifecycle": "live_verified"}))
        return _redirect(f"/workflows/{workflow_id}/{version}", "Live-Test bestätigt")

    @app.post("/workflows/{workflow_id}/{version}/activate")
    async def activate(request: Request, workflow_id: str, version: int):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        if workflow.lifecycle != "live_verified":
            raise HTTPException(409, "A verified live test is required before activation")
        active = workflow.model_copy(update={"enabled": True, "lifecycle": "active"})
        _db(request).save_workflow(active)
        return _redirect(f"/workflows/{workflow_id}/{version}", "Workflow aktiviert")

    @app.post("/profile")
    async def save_profile(request: Request):
        form = await request.form()
        profile = ApplicantProfile(
            first_name=str(form.get("first_name", "")),
            last_name=str(form.get("last_name", "")),
            email=str(form.get("email", "")),
            phone=str(form.get("phone", "")),
            street=str(form.get("street", "")),
            postcode=str(form.get("postcode", "")),
            city=str(form.get("city", "Berlin")),
            household_size=int(form.get("household_size", 1)),
            has_wbs=form.get("has_wbs") == "on",
            wbs_type=str(form.get("wbs_type", "")),
            wbs_rooms=float(form["wbs_rooms"]) if form.get("wbs_rooms") else None,
            wbs_valid_until=date.fromisoformat(str(form["wbs_valid_until"]))
            if form.get("wbs_valid_until")
            else None,
        )
        _db(request).save_profile(profile)
        return _redirect("/", "Profil gespeichert")

    @app.post("/secrets")
    async def save_secret(
        request: Request,
        key: Annotated[str, Form()],
        value: Annotated[str, Form()],
    ):
        request.app.state.secrets.set(key.strip(), value)
        return _redirect("/", "Zugangswert im Windows Credential Manager gespeichert")

    @app.post("/mail/settings")
    async def save_mail_settings(
        request: Request,
        username: Annotated[str, Form()],
        app_password: Annotated[str, Form()],
    ):
        request.app.state.secrets.set("webde_username", username)
        request.app.state.secrets.set("webde_app_password", app_password)
        return _redirect("/", "WEB.DE-Zugang gespeichert")

    @app.post("/documents")
    async def add_document(
        request: Request,
        document_type: Annotated[str, Form()],
        expires_at: Annotated[str, Form()] = "",
        file: Annotated[UploadFile, File()] = None,
    ):
        if file is None:
            raise HTTPException(400, "File is required")
        expiry = date.fromisoformat(expires_at) if expires_at else None
        request.app.state.vault.add(file.file, file.filename or "document", document_type, expiry)
        return _redirect("/", "Dokument verschlüsselt abgelegt")

    @app.post("/applications/{application_id}/resume")
    async def resume_application(request: Request, application_id: int):
        application = _db(request).get_application(application_id)
        if not application or application["status"] not in {
            ApplicationStatus.MANUAL_ACTION,
            ApplicationStatus.FAILED,
        }:
            raise HTTPException(409, "Application is not paused")
        _db(request).update_application(application_id, ApplicationStatus.RECEIVED, "Manually resumed")
        return _redirect("/#applications", "Bewerbung fortgesetzt")

    @app.post("/api/v1/fredy/events")
    async def fredy_events(
        request: Request,
        event: FredyEvent,
        authorization: Annotated[str | None, Header()] = None,
    ):
        expected = request.app.state.secrets.get_or_create("fredy_webhook_token")
        supplied = authorization.removeprefix("Bearer ") if authorization else ""
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(401, "Invalid bearer token")
        inserted, duplicates = _db(request).ingest_event(event)
        _db(request).audit(
            "fredy_event",
            {
                "job_id": event.jobId,
                "provider": event.provider,
                "inserted": inserted,
                "duplicates": duplicates,
            },
        )
        return {"accepted": inserted, "duplicates": duplicates}

    @app.post("/api/v1/recorder/events", status_code=202)
    async def recorder_event(request: Request, event: RecorderEvent):
        try:
            recorded = request.app.state.recorder.receive(event)
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        if not recorded:
            raise HTTPException(409, "No recorder session is active")
        return {"recorded": True}

    @app.get("/api/v1/health")
    async def health(request: Request):
        return {
            "status": "ok",
            "worker": bool(request.app.state.worker.thread and request.app.state.worker.thread.is_alive()),
            "mail_configured": request.app.state.mailbox.configured(),
        }

    return app


async def _mail_loop(app: FastAPI, interval: int) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            messages = await asyncio.to_thread(app.state.mailbox.poll)
            for message in messages:
                app.state.mailbox.store(message)
                candidates = []
                for application in app.state.database.pending_email_applications():
                    workflow = app.state.database.get_workflow(
                        application["workflow_id"], application["workflow_version"]
                    )
                    if workflow:
                        candidates.append((application, workflow))
                match = correlate_mail(message, candidates)
                if match:
                    app.state.database.update_mail_match(
                        "INBOX", message.uid, match.application["id"], "queued"
                    )
                    app.state.worker.enqueue_email(message, match)
        except Exception as error:
            app.state.database.audit("mail_poll_failed", {"error": str(error)})


def _load_bundled_workflows(database: Database) -> None:
    for path in (APP_DIR / "bundled_workflows").glob("*.json"):
        workflow = WorkflowDefinition.model_validate_json(path.read_text(encoding="utf-8"))
        if database.get_workflow(workflow.id, workflow.version) is None:
            database.save_workflow(workflow)


def _db(request: Request) -> Database:
    return request.app.state.database


def _require_workflow(database: Database, workflow_id: str, version: int) -> WorkflowDefinition:
    workflow = database.get_workflow(workflow_id, version)
    if not workflow:
        raise HTTPException(404, "Workflow not found")
    return workflow


def _editable_workflow(database: Database, workflow_id: str, version: int) -> WorkflowDefinition:
    workflow = _require_workflow(database, workflow_id, version)
    if workflow.enabled:
        raise HTTPException(409, "Active workflow versions are immutable")
    return workflow


def _redirect(path: str, message: str) -> RedirectResponse:
    from urllib.parse import quote

    separator = "&" if "?" in path else "?"
    return RedirectResponse(f"{path}{separator}message={quote(message)}", status_code=303)


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _form_value(value: str) -> Any:
    text = value.strip()
    if text.casefold() in {"true", "false"}:
        return text.casefold() == "true"
    try:
        return float(text) if "." in text or "," in text else int(text)
    except ValueError:
        return text


def _slug(value: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-") or "workflow"


app = create_app()


def run() -> None:
    uvicorn.run(app, host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    run()
