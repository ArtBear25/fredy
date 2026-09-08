"""Local FastAPI dashboard and HTTP API."""

from __future__ import annotations

import asyncio
import hmac
import json
import secrets as token_secrets
from contextlib import asynccontextmanager
from datetime import date
from html import escape
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlparse

import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import ValidationError
from starlette.middleware.cors import CORSMiddleware

from app.browser import BrowserController
from app.config import Settings, settings
from app.database import Database
from app.email_service import MailMatch, ParsedMail, WebDeMailbox, _matching_link, correlate_mail
from app.models import (
    ApplicantProfile,
    Condition,
    ElementTarget,
    EmailTrigger,
    FredyEvent,
    FredyPriceChange,
    FredyProbe,
    ListingPayload,
    LocatorCandidate,
    RecorderEvent,
    RuleGroup,
    ValueBinding,
    WorkflowDefinition,
    WorkflowStep,
)
from app.recorder import RecorderService
from app.security import DocumentVault, SecretStore, instance_lock
from app.worker import ApplicationWorker
from app.workflow import WorkflowExecutor

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
        with instance_lock(runtime.data_dir / "instance.lock"):
            for stale in runtime.temp_dir.glob("wohnungsbot-*"):
                if stale.is_file():
                    stale.unlink()
            database = Database(runtime.database_path)
            secrets = secret_store or SecretStore()
            app.state.recorder_token = secrets.get_or_create("recorder_token")
            browser = BrowserController(
                runtime.chrome_profile_dir,
                APP_DIR / "recorder_extension",
                recorder_token=app.state.recorder_token,
                recorder_endpoint=f"http://127.0.0.1:{runtime.port}",
            )
            vault = DocumentVault(runtime.vault_dir, runtime.temp_dir, database, secrets)
            executor = WorkflowExecutor(browser, secrets, vault)
            worker = ApplicationWorker(
                database,
                browser,
                executor,
                runtime,
                callback_token=secrets.get_or_create("fredy_webhook_token"),
            )
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
                database.recover_interrupted()
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
    app.state.csrf_token = token_secrets.token_urlsafe(32)
    app.state.recorder_token = ""
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"chrome-extension://.*",
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Authorization"],
    )
    app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
    templates = Jinja2Templates(directory=APP_DIR / "templates")

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        client = request.client.host if request.client else ""
        if client not in {"127.0.0.1", "::1", "testclient"}:
            return JSONResponse({"detail": "Local access only"}, status_code=403)
        hosts = {"127.0.0.1", "localhost", "::1"}
        if client == "testclient":
            hosts.add("testserver")
        if request.url.hostname not in hosts:
            return JSONResponse({"detail": "Ungültiger Host"}, status_code=403)
        if request.method not in {"GET", "HEAD", "OPTIONS"} and not request.url.path.startswith("/api/v1/"):
            origin = request.headers.get("origin")
            if origin and origin != str(request.base_url).rstrip("/"):
                return JSONResponse({"detail": "Fremde Herkunft wird nicht zugelassen"}, status_code=403)
            await request.body()
            form = await request.form()
            token = str(form.get("csrf_token", ""))
            if not hmac.compare_digest(token, request.app.state.csrf_token):
                return JSONResponse({"detail": "Seite neu laden und erneut versuchen"}, status_code=403)
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; frame-ancestors 'none'; "
            "form-action 'self'; base-uri 'none'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        # HTML form POSTs derive their Origin header from the referrer policy. `no-referrer`
        # makes browsers send `Origin: null`, which our CSRF/origin guard correctly rejects even
        # for a button clicked on this very dashboard. Keep referrers local instead: same-origin
        # forms retain their real loopback origin, while cross-origin navigation still gets none.
        response.headers["Referrer-Policy"] = "same-origin"
        return response

    @app.exception_handler(ValueError)
    @app.exception_handler(ValidationError)
    async def invalid_input(request: Request, error: ValueError):
        message = str(error)
        if isinstance(error, ValidationError):
            message = "; ".join(item["msg"] for item in error.errors())
        if "text/html" in request.headers.get("accept", ""):
            if request.method not in {"GET", "HEAD"}:
                return _redirect("/", message)
            return HTMLResponse(
                '<!doctype html><html lang="de"><meta charset="utf-8">'
                "<title>Bewerbungsmodul – Daten prüfen</title>"
                "<h1>Gespeicherte Daten konnten nicht geladen werden</h1>"
                f'<p>{escape(message)}</p><p><a href="/">Zur Übersicht</a></p></html>',
                status_code=422,
            )
        return JSONResponse({"detail": message}, status_code=422)

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
                "paused": db.get_setting("paused", False),
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
                "readiness_errors": workflow.readiness_errors(),
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
                "unmatched_mails": _db(request).unmatched_mail_messages(),
                "workflow": _db(request).get_workflow(
                    application["workflow_id"], application["workflow_version"]
                )
                if application["workflow_id"]
                else None,
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
    def create_workflow(
        request: Request,
        name: Annotated[str, Form()],
        provider: Annotated[str, Form()],
        example_url: Annotated[str, Form()],
    ):
        try:
            _ensure_browser_idle(request)
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        provider_name = provider.strip()
        workflow_id = _slug(provider_name)
        existing = _db(request).get_workflow(workflow_id)
        version = 1
        if existing and existing.provider.casefold() == provider_name.casefold():
            version = existing.version + 1
        elif existing:
            workflow_id = f"{workflow_id}-{len(_db(request).list_workflows()) + 1}"
        workflow = WorkflowDefinition(
            id=workflow_id,
            name=name.strip(),
            provider=provider_name,
            version=version,
            allowed_domains=[_url_domain(example_url)],
        )
        try:
            request.app.state.browser.ensure_available()
        except ValueError as error:
            raise HTTPException(503, str(error)) from error
        _db(request).save_workflow(workflow)
        try:
            session_id = _start_verified_recorder(request, workflow, example_url)
        except ValueError as error:
            _db(request).delete_workflow_draft(workflow.id, workflow.version)
            raise HTTPException(400, str(error)) from error
        return _redirect(
            f"/workflows/{workflow.id}/{workflow.version}",
            f"Workflow-Aufnahme läuft mit Sitzung {session_id}",
        )

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
        parsed_value: Any = _rule_value(value, field, operator)
        condition = Condition(field=field, operator=operator, value=parsed_value)
        rules = workflow.rules.model_copy(
            update={"mode": mode, "conditions": [*workflow.rules.conditions, condition]}
        )
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
        condition = Condition(field=field, operator=operator, value=_rule_value(value, field, operator))
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
        trigger_id: Annotated[str, Form()] = "",
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        target = None
        if locator_strategy and locator_value:
            target = ElementTarget(
                label=label,
                candidates=[LocatorCandidate(strategy=locator_strategy, value=locator_value, score=80)],
            )
        binding = _step_binding(action, source, key, value)
        step = WorkflowStep(
            id="manual-" + token_secrets.token_hex(4),
            action=action,
            target=target,
            binding=binding,
        )
        _db(request).save_workflow(
            _replace_phase_steps(workflow, trigger_id, [*_phase_steps(workflow, trigger_id), step])
        )
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
        non_submitting: Annotated[str | None, Form()] = None,
        locator_strategy: Annotated[str, Form()] = "",
        locator_value: Annotated[str, Form()] = "",
        trigger_id: Annotated[str, Form()] = "",
        optional: Annotated[str | None, Form()] = None,
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        steps = []
        found = False
        selected_steps = _phase_steps(workflow, trigger_id)
        for step in selected_steps:
            if step.id != step_id:
                steps.append(step)
                continue
            found = True
            binding = _step_binding(step.action, source, key, value, value_format)
            target = step.target
            if (
                locator_strategy
                and locator_value
                and (
                    target is None
                    or target.candidates[0].strategy != locator_strategy
                    or target.candidates[0].value != locator_value
                )
            ):
                target = ElementTarget(
                    label=target.label if target else step.id,
                    candidates=[LocatorCandidate(strategy=locator_strategy, value=locator_value, score=100)],
                )
            steps.append(
                step.model_copy(
                    update={
                        "binding": binding,
                        "final_submission": final_submission is not None,
                        "non_submitting": non_submitting is not None,
                        "target": target,
                        "optional": optional is not None,
                    }
                )
            )
        if not found:
            raise HTTPException(404, "Step not found")
        _db(request).save_workflow(_replace_phase_steps(workflow, trigger_id, steps))
        return _redirect(f"/workflows/{workflow_id}/{version}", "Schritt gespeichert")

    @app.post("/workflows/{workflow_id}/{version}/steps/{step_id}/order")
    def reorder_step(
        request: Request,
        workflow_id: str,
        version: int,
        step_id: str,
        direction: Annotated[str, Form()],
        trigger_id: Annotated[str, Form()] = "",
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        steps = list(_phase_steps(workflow, trigger_id))
        index = next((i for i, step in enumerate(steps) if step.id == step_id), None)
        if index is None:
            raise HTTPException(404, "Schritt fehlt")
        if direction == "delete":
            steps.pop(index)
        elif direction in {"up", "down"}:
            target_index = index + (-1 if direction == "up" else 1)
            if 0 <= target_index < len(steps):
                steps[index], steps[target_index] = steps[target_index], steps[index]
        else:
            raise ValueError("Unbekannte Reihenfolge")
        _db(request).save_workflow(_replace_phase_steps(workflow, trigger_id, steps))
        return _redirect(f"/workflows/{workflow_id}/{version}", "Schrittfolge gespeichert")

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
            id="mail-" + token_secrets.token_hex(4),
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
    def start_recorder(
        request: Request,
        workflow_id: str,
        version: int,
        example_url: Annotated[str, Form()],
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        _ensure_browser_idle(request)
        try:
            session_id = _start_verified_recorder(request, workflow, example_url)
        except ValueError as error:
            raise HTTPException(503, str(error)) from error
        return _redirect(
            f"/workflows/{workflow_id}/{version}",
            f"Recorder verbunden · Sitzung {session_id}",
        )

    @app.post("/recorder/{session_id}/stop")
    def stop_recorder(request: Request, session_id: str):
        try:
            workflow = request.app.state.recorder.stop(session_id)
        except ValueError as error:
            session = _db(request).recorder_session(session_id)
            if not session:
                raise HTTPException(404, "Recorder-Sitzung fehlt") from error
            return _redirect(
                f"/workflows/{session['workflow_id']}/{session['workflow_version']}",
                f"Aufnahme nicht übernommen: {error}. Die Sitzung bleibt aktiv.",
            )
        return _redirect(
            f"/workflows/{workflow.id}/{workflow.version}",
            "Aufzeichnung gespeichert und automatisch aktiviert",
        )

    @app.post("/recorder/{session_id}/cancel")
    def cancel_recorder(request: Request, session_id: str):
        session = _db(request).recorder_session(session_id)
        if not session:
            raise HTTPException(404, "Recorder-Sitzung fehlt")
        request.app.state.recorder.cancel(session_id)
        return _redirect(
            f"/workflows/{session['workflow_id']}/{session['workflow_version']}",
            "Aufnahme verworfen",
        )

    @app.get("/recorder/{session_id}/status")
    def recorder_status(request: Request, session_id: str):
        session = _db(request).recorder_session(session_id)
        if not session:
            raise HTTPException(404, "Recorder-Sitzung fehlt")
        events = json.loads(session["events_json"] or "[]")
        return {
            "active": bool(session["active"]),
            "ready": bool(session["ready"]),
            "event_count": len(events),
            "error": _db(request).get_setting(f"recorder.error.{session_id}"),
            "updated_at": session["updated_at"],
        }

    @app.post("/workflows/{workflow_id}/{version}/email/{trigger_id}/record/{uid}")
    def record_email_continuation(
        request: Request,
        workflow_id: str,
        version: int,
        trigger_id: str,
        uid: int,
        mailbox: Annotated[str, Form()] = "INBOX",
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        _ensure_browser_idle(request)
        trigger = next((item for item in workflow.email_triggers if item.id == trigger_id), None)
        message = _db(request).get_mail_message(mailbox, uid)
        if not trigger or not message:
            raise HTTPException(404, "Mail trigger or message not found")
        links = json.loads(message["links_json"])
        link = _matching_link(links, trigger, workflow)
        if not link:
            raise HTTPException(409, "Mail contains no single allowed matching link")
        try:
            session_id = _start_verified_recorder(
                request,
                workflow,
                link,
                mode="email",
                trigger_id=trigger_id,
            )
        except ValueError as error:
            raise HTTPException(503, str(error)) from error
        return _redirect(
            f"/workflows/{workflow_id}/{version}",
            f"E-Mail-Recorder verbunden · Sitzung {session_id}",
        )

    def queue_test(
        request: Request,
        workflow_id: str,
        version: int,
        mode: str,
        example_url: str,
        listing_id: str,
        title: str,
        price: str,
        rooms: str,
        size: str,
        description: str,
    ):
        workflow = _editable_workflow(_db(request), workflow_id, version)
        listing = ListingPayload(
            id=listing_id or example_url,
            url=example_url,
            title=title,
            description=description,
            price=price,
            rooms=rooms,
            size=size,
        )
        application_id = _db(request).create_test(workflow, listing, mode)
        return _redirect(f"/applications/{application_id}", "Test wurde eingeplant")

    @app.post("/workflows/{workflow_id}/{version}/dry-run")
    def dry_run(
        request: Request,
        workflow_id: str,
        version: int,
        example_url: Annotated[str, Form()],
        listing_id: Annotated[str, Form()] = "",
        title: Annotated[str, Form()] = "",
        price: Annotated[str, Form()] = "",
        rooms: Annotated[str, Form()] = "",
        size: Annotated[str, Form()] = "",
        description: Annotated[str, Form()] = "",
    ):
        return queue_test(
            request,
            workflow_id,
            version,
            "dry-run",
            example_url,
            listing_id,
            title,
            price,
            rooms,
            size,
            description,
        )

    @app.post("/workflows/{workflow_id}/{version}/live-test")
    def live_test(
        request: Request,
        workflow_id: str,
        version: int,
        example_url: Annotated[str, Form()],
        confirm: Annotated[str, Form()] = "",
        listing_id: Annotated[str, Form()] = "",
        title: Annotated[str, Form()] = "",
        price: Annotated[str, Form()] = "",
        rooms: Annotated[str, Form()] = "",
        size: Annotated[str, Form()] = "",
        description: Annotated[str, Form()] = "",
    ):
        if confirm != "yes":
            raise HTTPException(409, "Eine ausdrückliche Bestätigung des echten Versands ist erforderlich")
        return queue_test(
            request,
            workflow_id,
            version,
            "live-test",
            example_url,
            listing_id,
            title,
            price,
            rooms,
            size,
            description,
        )

    @app.post("/workflows/{workflow_id}/{version}/activate")
    def activate(request: Request, workflow_id: str, version: int):
        _db(request).activate_workflow(workflow_id, version)
        return _redirect(f"/workflows/{workflow_id}/{version}", "Workflow aktiviert")

    @app.post("/workflows/{workflow_id}/{version}/deactivate")
    def deactivate(request: Request, workflow_id: str, version: int):
        _db(request).deactivate_workflow(workflow_id, version)
        return _redirect(f"/workflows/{workflow_id}/{version}", "Workflow deaktiviert")

    @app.post("/workflows/{workflow_id}/{version}/delete")
    def delete_workflow(request: Request, workflow_id: str, version: int):
        if not _db(request).delete_workflow(workflow_id, version):
            raise ValueError("Workflow fehlt")
        return _redirect("/", "Workflow gelöscht")

    @app.post("/worker/pause")
    def pause_worker(request: Request, paused: Annotated[str, Form()] = "yes"):
        _db(request).set_setting("paused", paused == "yes")
        return _redirect("/", "Verarbeitung pausiert" if paused == "yes" else "Verarbeitung freigegeben")

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
            extra=_db(request).get_profile().extra,
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
    def add_document(
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
    def resume_application(
        request: Request,
        application_id: int,
        resolution: Annotated[str, Form()] = "resume",
        confirm_not_sent: Annotated[str, Form()] = "",
    ):
        if resolution == "not-sent" and confirm_not_sent != "yes":
            raise ValueError("Die Prüfung beim Anbieter ausdrücklich bestätigen")
        _db(request).resume_application(application_id, resolution=resolution)
        return _redirect(f"/applications/{application_id}", "Entscheidung gespeichert")

    @app.post("/applications/{application_id}/assign-mail")
    def assign_mail(
        request: Request,
        application_id: int,
        message_key: Annotated[str, Form()],
        trigger_id: Annotated[str, Form()],
        confirm: Annotated[str, Form()] = "",
    ):
        application = _db(request).get_application(application_id)
        if not application or application["status"] != "email_pending" or confirm != "yes":
            raise ValueError("Eine wartende Bewerbung und die ausdrückliche Zuordnung sind erforderlich")
        mailbox, uid = json.loads(message_key)
        stored = _db(request).get_mail_message(mailbox, int(uid))
        if not stored or stored["action_status"] != "unmatched":
            raise ValueError("Diese Mail wurde bereits zugeordnet")
        workflow = WorkflowDefinition.model_validate_json(application["workflow_snapshot"])
        trigger = next((item for item in workflow.email_triggers if item.id == trigger_id), None)
        if not trigger:
            raise ValueError("E-Mail-Regel fehlt")
        links = json.loads(stored["links_json"])
        link = _matching_link(links, trigger, workflow)
        if not link:
            raise ValueError("Die Mail enthält keinen einzelnen freigegebenen Bestätigungslink")
        parsed = ParsedMail(
            uid=uid,
            message_id=stored["message_id"],
            sender=stored["sender"],
            subject=stored["subject"],
            received_at=stored["received_at"],
            body=stored["body_text"],
            links=links,
            mailbox=mailbox,
        )
        if not request.app.state.worker.enqueue_email(
            parsed, MailMatch(application, workflow, trigger, link), mailbox
        ):
            raise ValueError("Mail oder Bewerbung wurde inzwischen verarbeitet")
        _db(request).audit(
            "manual_mail_assignment",
            {"mailbox": mailbox, "uid": uid, "trigger_id": trigger_id},
            application_id,
        )
        return _redirect(f"/applications/{application_id}", "Mail wurde der Bewerbung zugeordnet")

    def require_fredy(request: Request, authorization: str | None) -> None:
        expected = request.app.state.secrets.get_or_create("fredy_webhook_token")
        supplied = authorization.removeprefix("Bearer ") if authorization else ""
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(401, "Invalid bearer token")

    @app.get("/api/v1/fredy/workflows")
    async def fredy_workflows(
        request: Request,
        authorization: Annotated[str | None, Header()] = None,
    ):
        require_fredy(request, authorization)
        providers = sorted(
            {
                workflow.provider.strip().casefold()
                for workflow in _db(request).list_workflows()
                if workflow.enabled and workflow.provider.strip()
            }
        )
        return {"providers": providers}

    @app.post("/api/v1/fredy/events")
    async def fredy_events(
        request: Request,
        event: FredyEvent | FredyPriceChange | FredyProbe,
        authorization: Annotated[str | None, Header()] = None,
    ):
        require_fredy(request, authorization)
        if isinstance(event, FredyProbe):
            _db(request).audit("fredy_channel_test", {})
            return {"accepted": 0, "reason": "test"}
        if isinstance(event, FredyPriceChange):
            _db(request).audit(
                "price_change_ignored", {"count": len(event.priceChanges), "job_id": event.jobId}
            )
            return {"accepted": 0, "ignored": len(event.priceChanges), "reason": "priceChange"}
        requested = [listing for listing in event.listings if listing.applyRequested]
        ignored = len(event.listings) - len(requested)
        inserted = duplicates = 0
        if requested:
            queued_event = event.model_copy(update={"listings": requested})
            inserted, duplicates = _db(request).ingest_event(queued_event)
        _db(request).audit(
            "fredy_event",
            {
                "job_id": event.jobId,
                "provider": event.provider,
                "inserted": inserted,
                "duplicates": duplicates,
                "ignored": ignored,
            },
        )
        return {"accepted": inserted, "duplicates": duplicates, "ignored": ignored}

    def require_recorder(request: Request) -> None:
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ")
        if not hmac.compare_digest(supplied, request.app.state.recorder_token):
            raise HTTPException(401, "Recorder-Zugang ungültig")

    @app.get("/api/v1/recorder/session")
    def recorder_session(request: Request):
        require_recorder(request)
        session = _db(request).active_recorder()
        if not session:
            return {"active": False}
        _require_workflow(_db(request), session["workflow_id"], session["workflow_version"])
        return {
            "active": True,
            "session_id": session["id"],
            "tab_id": session["tab_id"],
        }

    @app.post("/api/v1/recorder/events", status_code=202)
    async def recorder_event(request: Request, event: RecorderEvent):
        require_recorder(request)
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
            poll_task = asyncio.create_task(asyncio.to_thread(app.state.mailbox.poll))
            try:
                await asyncio.shield(poll_task)
            except asyncio.CancelledError:
                # The IMAP thread can still persist messages; finish before closing SQLite.
                await poll_task
                raise
            if not app.state.mailbox.current_mailbox:
                continue
            for stored in app.state.database.unmatched_mail_messages(app.state.mailbox.current_mailbox):
                message = ParsedMail(
                    uid=stored["uid"],
                    message_id=stored["message_id"],
                    sender=stored["sender"],
                    subject=stored["subject"],
                    received_at=stored["received_at"],
                    body=stored["body_text"],
                    links=json.loads(stored["links_json"]),
                    mailbox=stored["mailbox"],
                )
                candidates = []
                for application in app.state.database.pending_email_applications():
                    workflow = (
                        WorkflowDefinition.model_validate_json(application["workflow_snapshot"])
                        if application["workflow_snapshot"]
                        else None
                    )
                    if workflow:
                        candidates.append((application, workflow))
                match = correlate_mail(message, candidates)
                if match:
                    app.state.worker.enqueue_email(message, match, message.mailbox)
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
    if workflow.lifecycle == "active":
        raise HTTPException(409, "Veröffentlichte Versionen sind unveränderlich. Eine neue Version anlegen")
    return workflow


def _phase_steps(workflow: WorkflowDefinition, trigger_id: str) -> list[WorkflowStep]:
    if not trigger_id:
        return workflow.steps
    trigger = next((item for item in workflow.email_triggers if item.id == trigger_id), None)
    if trigger is None:
        raise ValueError("E-Mail-Regel fehlt")
    return trigger.continuation_steps


def _replace_phase_steps(
    workflow: WorkflowDefinition, trigger_id: str, steps: list[WorkflowStep]
) -> WorkflowDefinition:
    if not trigger_id:
        return workflow.model_copy(update={"steps": steps})
    triggers = [
        trigger.model_copy(update={"continuation_steps": steps}) if trigger.id == trigger_id else trigger
        for trigger in workflow.email_triggers
    ]
    return workflow.model_copy(update={"email_triggers": triggers})


def _start_verified_recorder(
    request: Request,
    workflow: WorkflowDefinition,
    example_url: str,
    *,
    mode: str = "application",
    trigger_id: str | None = None,
) -> str:
    recorder = request.app.state.recorder
    if mode == "application" and trigger_id is None:
        session_id = recorder.start(workflow, example_url)
    else:
        session_id = recorder.start(workflow, example_url, mode=mode, trigger_id=trigger_id)
    try:
        recorder.wait_until_ready(session_id)
    except ValueError:
        recorder.cancel(session_id)
        request.app.state.browser.quit()
        raise
    return session_id


def _ensure_browser_idle(request: Request) -> None:
    worker = request.app.state.worker
    owner = (
        _db(request).get_application(worker.browser_application_id) if worker.browser_application_id else None
    )
    if owner and owner["status"] in {"queued", "running", "received", "manual_action", "failed"}:
        raise ValueError(
            "Zuerst die laufende oder unterbrochene Bewerbung im Browser abschließen oder abbrechen"
        )


def _redirect(path: str, message: str) -> RedirectResponse:
    from urllib.parse import quote

    separator = "&" if "?" in path else "?"
    return RedirectResponse(f"{path}{separator}message={quote(message)}", status_code=303)


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _url_domain(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(400, "Eine vollständige HTTP(S)-Adresse ohne Zugangsdaten ist erforderlich")
    return parsed.hostname.casefold().strip(".")


def _form_value(value: str) -> str:
    return value


def _rule_value(value: str, field: str, operator: str) -> Any:
    text = value.strip()
    if field == "profile.has_wbs" or operator == "exists":
        if text.casefold() not in {"true", "false"}:
            raise ValueError("Für diese Regel true oder false angeben")
        return text.casefold() == "true"
    if operator in {"gt", "gte", "lt", "lte"} or field in {
        "listing.price",
        "listing.rooms",
        "listing.size",
        "profile.household_size",
        "profile.wbs_rooms",
    }:
        from app.rules import as_number

        number = as_number(text)
        if number is None:
            raise ValueError("Für diese Regel eine Zahl angeben")
        return number
    return value


def _step_binding(
    action: str, source: str, key: str, value: str, value_format: str = "none"
) -> ValueBinding | None:
    if action in {"click", "switch_frame", "default_content", "email_wait"}:
        return None
    if action in {"wait", "switch_tab", "assert"} and source == "literal" and value == "":
        return None
    return ValueBinding(source=source, key=key, value=value, format=value_format)


def _slug(value: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-") or "workflow"


app = create_app()


def run() -> None:
    uvicorn.run(app, host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    run()
