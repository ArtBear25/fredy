"""Regression cases from the architecture review, using isolated application data."""

import hashlib
import json
import sqlite3
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from selenium.common.exceptions import WebDriverException

from app.browser import BrowserController
from app.config import Settings
from app.database import Database
from app.email_service import ParsedMail, correlate_mail, parse_message
from app.main import _form_value, create_app
from app.models import (
    ApplicationStatus,
    Condition,
    ElementTarget,
    EmailTrigger,
    FredyEvent,
    ListingPayload,
    LocatorCandidate,
    RecorderEvent,
    RuleGroup,
    ValueBinding,
    WorkflowDefinition,
    WorkflowStep,
)
from app.recorder import RecorderService
from app.rules import evaluate_group
from app.worker import ApplicationWorker
from app.workflow import ManualActionRequired, WorkflowExecutor


def definition(version=1):
    target = ElementTarget(candidates=[LocatorCandidate(strategy="id", value="submit")])
    return WorkflowDefinition(
        id="sample",
        name="Sample",
        provider="sample",
        version=version,
        allowed_domains=["example.test"],
        steps=[
            WorkflowStep(id="open", action="navigate", binding=ValueBinding(source="listing", key="url")),
            WorkflowStep(id="submit", action="click", target=target, final_submission=True),
            WorkflowStep(id="success", action="assert", target=target, binding=ValueBinding(value="Success")),
        ],
    )


def checked(database, workflow, mode, listing=None):
    listing = listing or ListingPayload(id="sample-1", url="https://example.test/sample-1")
    application_id = database.create_test(workflow, listing, mode)
    attempt_id = database.start_attempt(application_id, mode)
    outcome = ApplicationStatus.DRY_RUN_PASSED if mode == "dry-run" else ApplicationStatus.COMPLETED
    database.update_application(application_id, outcome)
    database.finish_attempt(attempt_id, outcome)
    database.record_check(application_id)
    return application_id


def publish(database, workflow):
    database.save_workflow(workflow)
    database.activate_workflow(workflow.id, workflow.version)


def test_recorded_workflow_activates_without_test_gates(database):
    workflow = definition().model_copy(update={"enabled": True, "lifecycle": "active"})
    database.save_workflow(workflow)
    stored = database.get_workflow(workflow.id)
    assert not stored.enabled and stored.lifecycle == "recorded"
    assert not database.has_check(stored, "dry-run")
    assert not database.has_check(stored, "live-test")

    database.activate_workflow(workflow.id, 1)
    active = database.get_workflow(workflow.id, 1)
    assert active.enabled and active.lifecycle == "active"
    assert database.active_workflow("SAMPLE").id == workflow.id


def test_recorder_learns_domains_and_activates_without_manual_mapping(database):
    class FakeBrowser:
        def exclusive(self):
            return nullcontext()

        def reset_tabs(self):
            pass

        def open(self, _url):
            pass

    workflow = WorkflowDefinition(
        id="gewobag",
        name="Gewobag",
        provider="gewobag",
        allowed_domains=["www.gewobag.de"],
    )
    database.save_workflow(workflow)
    recorder = RecorderService(database, FakeBrowser())
    session_id = recorder.start(
        workflow,
        "https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/example",
    )
    recorder.receive(
        RecorderEvent(
            action="ready",
            url="https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/example",
            session_id=session_id,
            tab_id=7,
        )
    )
    recorder.receive(
        RecorderEvent(
            action="click",
            url="https://formular.example.test/application/123",
            target=ElementTarget(
                label="Weiter",
                candidates=[LocatorCandidate(strategy="id", value="continue")],
            ),
            session_id=session_id,
            tab_id=7,
        )
    )

    recorded = recorder.stop(session_id)
    assert recorded.enabled
    assert recorded.lifecycle == "active"
    assert recorded.allowed_domains == ["www.gewobag.de", "formular.example.test"]
    assert recorded.steps[0].action == "navigate"
    assert recorded.steps[0].binding.source == "listing"
    assert recorded.steps[0].binding.key == "url"
    assert recorded.steps[1].action == "click"


def test_invalid_recorder_stop_keeps_session_active_until_explicit_cancel(database):
    class FakeBrowser:
        def exclusive(self):
            return nullcontext()

        def reset_tabs(self):
            pass

        def open(self, _url):
            pass

    workflow = WorkflowDefinition(
        id="wbm",
        name="WBM",
        provider="wbm",
        allowed_domains=["www.wbm.de"],
    )
    database.save_workflow(workflow)
    recorder = RecorderService(database, FakeBrowser())
    session_id = recorder.start(workflow, "https://www.wbm.de/wohnungen-berlin/example")

    with pytest.raises(ValueError, match="Keine vollständige Aufnahme"):
        recorder.stop(session_id)

    assert database.active_recorder()["id"] == session_id
    recorder.cancel(session_id)
    assert database.active_recorder() is None


def test_recorder_token_survives_backend_restart(tmp_path, secrets):
    first = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(first):
        first_token = first.state.recorder_token
    second = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(second):
        assert second.state.recorder_token == first_token
        assert second.state.recorder_token == secrets.get("recorder_token")


def test_new_version_replaces_active_workflow_only_after_activation(database):
    first = definition()
    database.save_workflow(first)
    database.activate_workflow(first.id, first.version)

    second = definition(2)
    database.save_workflow(second)
    assert database.get_workflow(first.id, 1).enabled
    assert not database.get_workflow(first.id, 2).enabled

    database.activate_workflow(second.id, second.version)
    assert not database.get_workflow(first.id, 1).enabled
    assert database.get_workflow(first.id, 2).enabled
    database.deactivate_workflow(first.id, 2)
    assert not database.get_workflow(first.id, 2).enabled
    with pytest.raises(ValueError, match="immutable"):
        database.save_workflow(database.get_workflow(first.id, 1).model_copy(update={"name": "Edit"}))


def test_live_test_and_fredy_share_duplicate_protection(database):
    workflow = definition()
    database.save_workflow(workflow)
    listing = ListingPayload(id="different-from-fredy", url="https://example.test/a")
    checked(database, workflow, "dry-run", listing)
    checked(database, workflow, "live-test", listing)
    with pytest.raises(ValueError, match="bereits"):
        database.create_test(workflow, listing, "live-test")
    event = FredyEvent(
        jobId="j",
        provider="SAMPLE",
        timestamp=datetime.now(UTC),
        listings=[listing.model_copy(update={"id": "fredy-hash"})],
    )
    assert database.ingest_event(event) == (0, 1)


def test_scout_match_routes_application_to_official_provider_and_direct_url(database):
    scout_url = "https://www.immobilienscout24.de/expose/170555494"
    provider_url = "https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/7100-79011-0101-0005"
    listing = ListingPayload(
        id="scout-buttmann",
        url=scout_url,
        officialProvider="gewobag",
        providerLink=provider_url,
    )
    event = FredyEvent(
        jobId="j",
        provider="immoscout",
        timestamp=datetime.now(UTC),
        listings=[listing],
    )

    assert database.ingest_event(event) == (1, 0)
    assert database.ingest_event(event) == (0, 1)
    application = database.claim_next_application()
    assert application["provider"] == "gewobag"
    assert application["canonical_url"] == provider_url
    stored_listing = json.loads(application["listing_json"])
    assert stored_listing["url"] == scout_url
    assert stored_listing["providerLink"] == provider_url
    assert stored_listing["officialProvider"] == "gewobag"


def test_scout_provider_name_without_confirmed_direct_link_stays_on_scout_path(database):
    scout_url = "https://www.immobilienscout24.de/expose/170555494"
    listing = ListingPayload(
        id="scout-only",
        url=scout_url,
        officialProvider="gewobag",
    )
    event = FredyEvent(
        jobId="j",
        provider="immoscout",
        timestamp=datetime.now(UTC),
        listings=[listing],
    )

    assert database.ingest_event(event) == (1, 0)
    application = database.claim_next_application()
    assert application["provider"] == "immoscout"
    assert application["canonical_url"] == scout_url


def test_worker_looks_up_matched_scout_workflow_by_provider():
    class LookupDatabase:
        def __init__(self):
            self.lookup = None

        def start_attempt(self, application_id, mode):
            return 1

        def active_workflow(self, provider):
            self.lookup = provider
            return None

        def update_application(self, *args, **kwargs):
            pass

        def finish_attempt(self, *args, **kwargs):
            pass

        def audit(self, *args, **kwargs):
            pass

    provider_url = "https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/1"
    database = LookupDatabase()
    worker = ApplicationWorker(database, None, None, None)
    worker._process_application(
        {
            "id": 1,
            "mode": "application",
            "phase": "main",
            "provider": "gewobag",
            "listing_json": json.dumps(
                {
                    "id": "scout-1",
                    "url": "https://www.immobilienscout24.de/expose/1",
                    "officialProvider": "gewobag",
                    "providerLink": provider_url,
                }
            ),
        }
    )
    assert database.lookup == "gewobag"


def test_empty_workflow_is_rejected_but_recorded_clicks_need_no_manual_review(database):
    workflow = definition().model_copy(update={"steps": []})
    assert workflow.readiness_errors()
    with pytest.raises(ValueError):
        database.create_test(workflow, ListingPayload(id="x", url="https://example.test/x"), "dry-run")
    recorded = definition()
    recorded.steps[1].final_submission = False
    assert not recorded.readiness_errors()


def test_numeric_contract_and_literal_values():
    listing = ListingPayload(id="x", url="https://example.test/x", price="1.250 EUR", rooms="2 Zimmer")
    assert listing.price == 1250
    assert listing.rooms == 2
    assert not evaluate_group(
        RuleGroup(conditions=[Condition(field="listing.price", operator="lte", value=700)]),
        {"listing": listing.model_dump()},
    )
    assert evaluate_group(
        RuleGroup(conditions=[Condition(field="listing.rooms", operator="eq", value=2)]),
        {"listing": listing.model_dump()},
    )
    assert _form_value("030123456") == "030123456"
    assert not evaluate_group(RuleGroup(mode="any", groups=[RuleGroup()]), {})


def test_browser_restarts_stale_selenium_session(tmp_path, monkeypatch):
    class StaleDriver:
        quit_called = False

        @property
        def current_window_handle(self):
            raise WebDriverException("session is gone")

        def quit(self):
            self.quit_called = True
            raise WebDriverException("already gone")

    class FreshDriver:
        current_window_handle = "fresh"

    browser = BrowserController(tmp_path / "profile")
    stale = StaleDriver()
    fresh = FreshDriver()
    browser._driver = stale
    monkeypatch.setattr(browser, "_start", lambda: fresh)

    assert browser.driver is fresh
    assert stale.quit_called


def test_recorder_extension_runtime_changes_when_token_changes(tmp_path, monkeypatch):
    source = tmp_path / "extension"
    source.mkdir()
    (source / "manifest.json").write_text("{}", encoding="utf-8")
    captured = []

    class FakeDriver:
        def set_page_load_timeout(self, _timeout):
            pass

    monkeypatch.setattr(
        "app.browser.webdriver.Chrome",
        lambda *, service, options: captured.append(options) or FakeDriver(),
    )

    runtime_paths = []
    for token in ("old-token", "new-token"):
        browser = BrowserController(tmp_path / "profile", source, recorder_token=token)
        monkeypatch.setattr(
            browser,
            "_runtime",
            lambda: {"browser_path": "chrome.exe", "driver_path": "chromedriver.exe"},
        )
        browser._start()
        load_argument = next(arg for arg in captured[-1].arguments if arg.startswith("--load-extension="))
        runtime_path = Path(load_argument.split("=", 1)[1])
        runtime_paths.append(runtime_path)
        expected_id = hashlib.sha256(token.encode()).hexdigest()[:12]
        assert runtime_path.name == f"recorder-extension-{expected_id}"
        assert f"--disable-extensions-except={runtime_path}" in captured[-1].arguments
        assert token in (runtime_path / "settings.js").read_text(encoding="utf-8")

    assert runtime_paths[0] != runtime_paths[1]


def test_windows_launcher_owns_backend_process_tree():
    launcher = Path(__file__).resolve().parents[1] / "Bewerbungsmodul starten.cmd"
    content = launcher.read_text(encoding="utf-8")
    assert 'if /I "%~1"=="--console" goto console' in content
    assert "-ArgumentList '--console'" in content
    assert "-WindowStyle Normal" in content
    assert content.count("-WindowStyle Hidden") == 1
    assert "KILL_ON_CLOSE=0x2000" in content
    assert "AssignProcessToJobObject" in content
    assert "$holder.WaitForExit()" in content
    assert ".venv\\Scripts\\python.exe" in content


def test_active_recorder_stop_button_is_available_without_inline_javascript(tmp_path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(app) as client:
        workflow = definition().model_copy(update={"enabled": False, "lifecycle": "recorded"})
        app.state.database.save_workflow(workflow)
        app.state.database.start_recorder("live-session", workflow.id, workflow.version)

        response = client.get(f"/workflows/{workflow.id}/{workflow.version}")

        assert response.status_code == 200
        assert '<button id="recorder-stop">Aufzeichnung beenden und übernehmen</button>' in response.text
        assert "<script>" not in response.text


def test_new_provider_starts_recording_from_example_expose(tmp_path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(app) as client:
        started = []
        app.state.browser.ensure_available = lambda: None
        app.state.recorder.wait_until_ready = lambda _session_id: None

        def start(workflow, example_url):
            started.append((workflow.id, workflow.version, example_url))
            return "test-session"

        app.state.recorder.start = start
        data = {
            "name": "Gewobag",
            "provider": "gewobag",
            "example_url": "https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/example/",
            "csrf_token": app.state.csrf_token,
        }
        response = client.post(
            "/workflows",
            data=data,
            headers={"Origin": "http://testserver"},
            follow_redirects=False,
        )
        assert response.status_code == 303
        assert response.headers["Referrer-Policy"] == "same-origin"
        created_version = started[0][1]
        workflow = app.state.database.get_workflow("gewobag", created_version)
        assert workflow.allowed_domains == ["www.gewobag.de"]
        assert started == [("gewobag", created_version, data["example_url"])]

        response = client.post("/workflows", data=data, follow_redirects=False)
        assert response.status_code == 303
        assert app.state.database.get_workflow("gewobag", created_version + 1) is not None
        assert started[-1] == ("gewobag", created_version + 1, data["example_url"])


def test_failed_new_provider_recording_leaves_no_draft(tmp_path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(app) as client:
        app.state.browser.ensure_available = lambda: None

        def fail_start(_workflow, _example_url):
            raise ValueError("Chrome konnte nicht geöffnet werden")

        app.state.recorder.start = fail_start
        response = client.post(
            "/workflows",
            data={
                "name": "Berlinovo",
                "provider": "berlinovo",
                "example_url": "https://www.berlinovo.de/de/wohnung-id/example",
                "csrf_token": app.state.csrf_token,
            },
            headers={"Origin": "http://testserver"},
            follow_redirects=False,
        )

        assert response.status_code == 400
        assert app.state.database.get_workflow("berlinovo") is None


def test_unverified_recorder_is_cancelled_and_browser_recycled(tmp_path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(app) as client:
        app.state.browser.ensure_available = lambda: None
        quit_calls = []
        app.state.browser.quit = lambda: quit_calls.append(True)

        def start(workflow, _example_url):
            session_id = "broken-session"
            app.state.database.start_recorder(session_id, workflow.id, workflow.version)
            return session_id

        app.state.recorder.start = start

        def fail_ready(_session_id):
            raise ValueError("Chrome-Recorder hat keine Verbindung zu Fredy hergestellt")

        app.state.recorder.wait_until_ready = fail_ready
        response = client.post(
            "/workflows",
            data={
                "name": "Berlinovo",
                "provider": "berlinovo",
                "example_url": "https://www.berlinovo.de/de/wohnung-id/example",
                "csrf_token": app.state.csrf_token,
            },
            headers={"Origin": "http://testserver"},
            follow_redirects=False,
        )

        assert response.status_code == 400
        assert app.state.database.active_recorder() is None
        assert quit_calls == [True]
        assert app.state.database.get_workflow("berlinovo") is None


def test_rule_edit_preserves_groups_and_rejects_foreign_mutations(tmp_path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(app) as client:
        workflow = definition().model_copy(
            update={
                "rules": RuleGroup(
                    groups=[
                        RuleGroup(conditions=[Condition(field="listing.price", operator="lte", value=700)])
                    ]
                )
            }
        )
        app.state.database.save_workflow(workflow)
        data = {
            "mode": "all",
            "field": "listing.rooms",
            "operator": "gte",
            "value": "1",
            "csrf_token": app.state.csrf_token,
        }
        response = client.post("/workflows/sample/1/rules", data=data, follow_redirects=False)
        assert response.status_code == 303
        assert len(app.state.database.get_workflow("sample", 1).rules.groups) == 1
        assert (
            client.post(
                "/workflows/sample/1/rules", data=data, headers={"Origin": "https://foreign.example"}
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/workflows/sample/1/rules", data={k: v for k, v in data.items() if k != "csrf_token"}
            ).status_code
            == 403
        )
        response = client.post(
            "/workflows/sample/1/steps", data={"action": "fill", "csrf_token": app.state.csrf_token}
        )
        assert response.status_code == 422
        assert client.get("/", headers={"Host": "rebound.example"}).status_code == 403
        assert 'name="csrf_token"' in client.get("/").text


def test_html_links_and_exact_mail_correlation():
    raw = (
        b"From: service@example.test\r\nSubject: Confirm\r\nContent-Type: "
        b"text/html; charset=utf-8\r\n\r\n<a "
        b'href="https://example.test/confirm/flat-2?a=1&amp;b=2">Confirm</a'
        b">"
    )
    parsed = parse_message(1, raw)
    assert parsed.links == ["https://example.test/confirm/flat-2?a=1&b=2"]
    workflow = definition().model_copy(
        update={
            "email_triggers": [
                EmailTrigger(id="mail", sender_pattern=r"@example\.test", link_pattern="confirm")
            ]
        }
    )

    def candidate(i):
        return {
            "id": i,
            "provider": "sample",
            "listing_json": json.dumps({"id": f"flat-{i}", "url": f"https://example.test/flat-{i}"}),
        }

    assert correlate_mail(parsed, [(candidate(1), workflow)]) is None
    match = correlate_mail(parsed, [(candidate(1), workflow), (candidate(2), workflow)])
    assert match and match.application["id"] == 2


def test_restart_keeps_uncertain_submission_for_manual_resolution(database):
    listing = ListingPayload(id="x", url="https://example.test/x")
    database.ingest_event(
        FredyEvent(jobId="j", provider="sample", timestamp=datetime.now(UTC), listings=[listing])
    )
    application = database.claim_next_application()
    database.pin_application(application["id"], definition())
    database.checkpoint(application["id"], 1, "intent")
    database.recover_interrupted()
    stored = database.get_application(application["id"])
    assert stored["status"] == ApplicationStatus.MANUAL_ACTION
    assert stored["workflow_snapshot"] is not None
    assert database.claim_next_application() is None
    with pytest.raises(ValueError, match="unklar"):
        database.resume_application(application["id"])
    database.resume_application(application["id"], resolution="not-sent")
    assert database.claim_next_application()["submission_state"] == "none"


def test_domain_checked_before_typing_and_missing_profile_before_navigation():
    class Element:
        text = "Success"
        value = None

        def clear(self):
            pass

        def send_keys(self, value):
            self.value = value

        def get_attribute(self, name):
            return "text"

    class Driver:
        current_url = "https://foreign.example"

        def execute_script(self, code):
            return self.current_url

    class Browser:
        driver = Driver()
        element = Element()
        opens = 0

        def find(self, *args, **kwargs):
            return self.element

        def has_blocked_action_page(self):
            return False

        def has_manual_challenge(self):
            return False

        def open(self, url):
            self.opens += 1

    browser = Browser()
    executor = WorkflowExecutor(browser, None, None)
    workflow = definition()
    fill = WorkflowStep(
        id="name",
        action="fill",
        target=workflow.steps[1].target,
        binding=ValueBinding(source="profile", key="first_name"),
    )
    workflow.steps.insert(1, fill)
    with pytest.raises(ManualActionRequired):
        executor.execute(workflow, {"listing": {"url": "https://example.test/x"}, "profile": {}})
    assert browser.opens == 0
    with pytest.raises(ManualActionRequired):
        executor.execute(workflow, {"profile": {"first_name": "Private"}}, steps=[fill])
    assert browser.element.value is None


def test_reviewed_click_does_not_gain_an_empty_required_binding(tmp_path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(app) as client:
        app.state.database.save_workflow(definition())
        response = client.post(
            "/workflows/sample/1/steps/submit",
            data={"csrf_token": app.state.csrf_token, "source": "literal", "final_submission": "on"},
            follow_redirects=False,
        )
        assert response.status_code == 303
        stored = app.state.database.get_workflow("sample")
        assert stored.steps[1].binding is None
        assert stored.readiness_errors() == []


def test_data_directory_lock_prevents_a_second_service(tmp_path):
    from app.security import instance_lock

    path = tmp_path / "instance.lock"
    with instance_lock(path):
        with pytest.raises(RuntimeError, match="bereits"):
            with instance_lock(path):
                pass
    with instance_lock(path):
        pass


def test_missing_document_is_checked_before_opening_browser(database, secrets, tmp_path):
    from unittest.mock import Mock

    from app.security import DocumentVault

    workflow = definition()
    workflow.steps.insert(
        1,
        WorkflowStep(
            id="document",
            action="upload",
            target=workflow.steps[1].target,
            binding=ValueBinding(source="document", key="missing"),
        ),
    )
    browser = Mock()
    executor = WorkflowExecutor(
        browser, secrets, DocumentVault(tmp_path / "vault", tmp_path / "temp", database, secrets)
    )
    with pytest.raises(ManualActionRequired, match="Dokument fehlt"):
        executor.execute(workflow, {"listing": {"url": "https://example.test/x"}})
    browser.open.assert_not_called()


def test_channel_probe_and_price_changes_never_enqueue_applications(tmp_path, secrets):
    app = create_app(Settings(data_dir=tmp_path, port=8876), start_background=False, secret_store=secrets)
    with TestClient(app, base_url="http://localhost:8876") as client:
        assert "http://localhost:8876/api/v1/fredy/events" in client.get("/").text
        headers = {"Authorization": "Bearer test-token"}
        for payload in [
            {"event": "test"},
            {
                "event": "priceChange",
                "jobId": "j",
                "provider": "sample",
                "timestamp": datetime.now(UTC).isoformat(),
                "priceChanges": [{"id": "x"}],
            },
        ]:
            response = client.post("/api/v1/fredy/events", json=payload, headers=headers)
            assert response.status_code == 200
            assert response.json()["accepted"] == 0
        assert app.state.database.claim_next_application() is None
        assert client.post("/api/v1/fredy/events", json={"event": "test"}).status_code == 401


def test_legacy_migration_backs_up_and_stops_uncertain_attempts(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    db = Database(path)
    publish(db, definition())
    db.ingest_event(
        FredyEvent(
            jobId="j",
            provider="sample",
            timestamp=datetime.now(UTC),
            listings=[ListingPayload(id="legacy", url="https://example.test/legacy")],
        )
    )
    application = db.claim_next_application()
    db.update_application(application["id"], ApplicationStatus.EMAIL_PENDING)
    db.close()
    with sqlite3.connect(path) as raw:
        raw.execute("DELETE FROM schema_version")
        raw.execute("INSERT INTO schema_version(version) VALUES(1)")
    upgraded = Database(path)
    try:
        assert not upgraded.get_workflow("sample").enabled
        entry = upgraded.get_application(application["id"])
        assert entry["status"] == "manual_action" and entry["submission_state"] == "intent"
        with sqlite3.connect(tmp_path / "legacy.pre-v2.sqlite3") as backup:
            assert backup.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 1
            assert backup.execute("SELECT enabled FROM workflows").fetchone()[0] == 1
    finally:
        upgraded.close()


def test_manual_mail_assignment_requires_confirmation_and_is_durable(tmp_path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(app) as client:
        db = app.state.database
        flow = definition()
        flow.steps.append(WorkflowStep(id="mail-wait", action="email_wait"))
        flow.email_triggers = [
            EmailTrigger(
                id="confirmation",
                sender_pattern="example",
                link_pattern="confirm",
                continuation_steps=[
                    WorkflowStep(
                        id="open-mail",
                        action="navigate",
                        final_submission=True,
                        binding=ValueBinding(source="email", key="link"),
                    ),
                    flow.steps[2],
                ],
            )
        ]
        db.save_workflow(flow)
        checked(db, flow, "dry-run")
        application = db.create_test(
            flow, ListingPayload(id="mail-flat", url="https://example.test/flat"), "live-test"
        )
        db.update_application(application, ApplicationStatus.EMAIL_PENDING)
        app.state.mailbox.store(
            ParsedMail(
                7,
                "message",
                "example",
                "Confirm",
                None,
                "No listing reference",
                ["https://example.test/confirm/token"],
            )
        )
        path = f"/applications/{application}/assign-mail"
        data = {
            "csrf_token": app.state.csrf_token,
            "message_key": json.dumps(["INBOX", 7]),
            "trigger_id": "confirmation",
        }
        assert client.post(path, data=data).status_code == 422
        assert "Bestätigungsmail zuordnen" in client.get(f"/applications/{application}").text
        assert client.post(path, data={**data, "confirm": "yes"}, follow_redirects=False).status_code == 303
        assert db.get_application(application)["phase"] == "email:confirmation"
        assert db.get_mail_message("INBOX", 7)["action_status"] == "queued"
        assert client.post(path, data={**data, "confirm": "yes"}).status_code == 422


def test_dashboard_loads_legacy_website_origin_without_redirect_loop(tmp_path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(app) as client:
        db = app.state.database
        db.save_workflow(definition())
        payload = definition().model_dump(mode="json")
        payload["allowed_domains"] = ["https://www.immobilienscout24.de"]
        # Reproduce a persisted draft from before strict validation was introduced.
        with sqlite3.connect(db.path) as raw:
            raw.execute("UPDATE workflows SET definition_json=? WHERE id='sample'", (json.dumps(payload),))
        response = client.get("/", headers={"Accept": "text/html"}, follow_redirects=False)
        assert response.status_code == 200
        assert client.get("/workflows/sample/1").status_code == 200
        assert db.get_workflow("sample").allowed_domains == ["www.immobilienscout24.de"]
        assert not db.get_workflow("sample").enabled

        payload["allowed_domains"] = ["https://example.test/a-path"]
        with sqlite3.connect(db.path) as raw:
            raw.execute("UPDATE workflows SET definition_json=? WHERE id='sample'", (json.dumps(payload),))
        response = client.get("/", headers={"Accept": "text/html"}, follow_redirects=False)
        assert response.status_code == 422
        assert "location" not in response.headers
        assert "Gespeicherte Daten" in response.text


def test_website_origin_normalization_does_not_expand_domain_permissions():
    assert WorkflowDefinition.normalize_domains(["https://WWW.example.test/", "www.example.test"]) == [
        "www.example.test"
    ]
    for value in [
        "https://user@example.test",
        "https://example.test:443",
        "https://example.test/x",
        "https://example.test?x=1",
        "https://example.test#x",
        "ftp://example.test",
    ]:
        with pytest.raises(ValueError):
            WorkflowDefinition.normalize_domains([value])
