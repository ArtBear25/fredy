"""Real local HTTP forms, Selenium, persistence and the public application API."""

from __future__ import annotations

import json
import socket
import threading
import time
from collections import Counter
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import uvicorn

from app.config import Settings
from app.email_service import ParsedMail, correlate_mail
from app.main import create_app
from app.models import (
    ApplicantProfile,
    ApplicationStatus,
    ElementTarget,
    EmailTrigger,
    LocatorCandidate,
    ValueBinding,
    WorkflowDefinition,
    WorkflowStep,
)
from app.worker import ApplicationWorker


@pytest.fixture
def live_local_app(tmp_path, secrets):
    submissions, confirmations = Counter(), Counter()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def page(self, html):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html.encode())

        def do_GET(self):
            query = parse_qs(urlsplit(self.path).query)
            listing = query.get("listing", ["flat-a"])[0]
            if self.path.startswith("/frames"):
                self.page(
                    '<iframe id="one" src="/frame?one"></iframe><iframe id="two" src="/frame?two"></iframe>'
                    '<a id="popup" href="/frame?popup" target="_blank">Open</a>'
                )
            elif self.path.startswith("/frame"):
                self.page(
                    '<label>Note<input name="note"></label><button type="button" id="blur">Done</button>'
                )
            elif self.path.startswith("/confirm"):
                confirmations[listing] += 1
                self.page('<div id="confirmed">Confirmed</div>')
            else:
                self.page(
                    '<form method="post" action="/submit">'
                    f'<input name="listing" type="hidden" value="{listing}">'
                    '<label>Name<input name="name"></label>'
                    '<button type="submit" id="submit">Apply</button></form>'
                )

        def do_POST(self):
            data = parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
            submissions[data["listing"][0]] += 1
            self.page('<div id="success">Received</div>')

    site = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    site_thread = threading.Thread(target=site.serve_forever, daemon=True)
    site_thread.start()
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    app = create_app(Settings(data_dir=tmp_path, port=port), start_background=False, secret_store=secrets)
    server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started
    app.state.browser.headless = True
    app.state.database.save_profile(ApplicantProfile(first_name="Ada"))
    client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=60)
    try:
        yield app, client, f"http://127.0.0.1:{site.server_port}", submissions, confirmations
    finally:
        client.close()
        server.should_exit = True
        thread.join(timeout=45)
        site.shutdown()
        site_thread.join(timeout=5)
        sock.close()
        assert not thread.is_alive()


def target(name):
    return ElementTarget(candidates=[LocatorCandidate(strategy="id", value=name)])


def flow():
    return WorkflowDefinition(
        id="local",
        name="Local",
        provider="local",
        allowed_domains=["127.0.0.1"],
        steps=[
            WorkflowStep(id="open", action="navigate", binding=ValueBinding(source="listing", key="url")),
            WorkflowStep(
                id="name",
                action="fill",
                target=ElementTarget(candidates=[LocatorCandidate(strategy="name", value="name")]),
                binding=ValueBinding(source="profile", key="first_name"),
            ),
            WorkflowStep(id="send", action="click", target=target("submit"), final_submission=True),
            WorkflowStep(
                id="success",
                action="assert",
                target=target("success"),
                binding=ValueBinding(value="Received"),
            ),
            WorkflowStep(id="mail", action="email_wait"),
        ],
        email_triggers=[
            EmailTrigger(
                id="confirmation",
                sender_pattern=r"@example\.test",
                link_pattern="/confirm",
                continuation_steps=[
                    WorkflowStep(
                        id="confirm",
                        action="navigate",
                        binding=ValueBinding(source="email", key="link"),
                        final_submission=True,
                    ),
                    WorkflowStep(
                        id="confirmed",
                        action="assert",
                        target=target("confirmed"),
                        binding=ValueBinding(value="Confirmed"),
                    ),
                ],
            )
        ],
    )


def post(client, app, path, **data):
    response = client.post(path, data={"csrf_token": app.state.csrf_token, **data})
    assert response.status_code == 303, response.text
    return response


def run_next(app):
    application = app.state.database.claim_next_application()
    assert application
    app.state.worker._process_application(application)
    return app.state.database.get_application(application["id"])


def mail_for(app, site, listing, uid):
    link = f"{site}/confirm?listing={listing}"
    parsed = ParsedMail(
        uid=uid,
        message_id=f"<{uid}@example.test>",
        sender="service@example.test",
        subject=f"Confirm {listing}",
        received_at=datetime.now(UTC).isoformat(),
        body=f"{listing} {link}",
        links=[link],
    )
    assert app.state.mailbox.store(parsed)
    candidates = [
        (a, app.state.database.get_workflow(a["workflow_id"], a["workflow_version"]))
        for a in app.state.database.pending_email_applications()
    ]
    match = correlate_mail(parsed, candidates)
    assert match is not None
    assert app.state.worker.enqueue_email(parsed, match)
    assert not app.state.worker.enqueue_email(parsed, match)
    return parsed, match


def test_real_forms_tests_activation_two_flats_and_durable_confirmation(live_local_app, monkeypatch):
    app, client, site, submissions, confirmations = live_local_app
    db = app.state.database
    db.save_workflow(flow())
    sample = {"example_url": f"{site}/?listing=flat-a", "listing_id": "flat-a"}
    post(client, app, "/workflows/local/1/dry-run", **sample)
    assert run_next(app)["status"] == ApplicationStatus.DRY_RUN_PASSED
    assert submissions == {}
    post(client, app, "/workflows/local/1/live-test", confirm="yes", **sample)
    assert run_next(app)["status"] == ApplicationStatus.EMAIL_PENDING
    assert submissions == {"flat-a": 1}
    mail_for(app, site, "flat-a", 1)
    assert run_next(app)["status"] == ApplicationStatus.COMPLETED
    post(client, app, "/workflows/local/1/activate")
    assert db.get_workflow("local", 1).enabled
    assert confirmations == {"flat-a": 1}
    # Two independent Fredy events enter through the actual HTTP API.
    for listing in ["flat-b", "flat-c"]:
        payload = {
            "jobId": "j",
            "provider": "local",
            "timestamp": datetime.now(UTC).isoformat(),
            "listings": [
                {
                    "id": listing,
                    "url": f"{site}/?listing={listing}",
                    "rooms": 2,
                    "applyRequested": True,
                    "applicationTrigger": "auto",
                }
            ],
        }
        headers = {"Authorization": "Bearer test-token"}
        assert client.post("/api/v1/fredy/events", json=payload, headers=headers).json()["accepted"] == 1
        assert client.post("/api/v1/fredy/events", json=payload, headers=headers).json()["duplicates"] == 1
        assert run_next(app)["status"] == ApplicationStatus.EMAIL_PENDING
    mail_for(app, site, "flat-b", 2)
    mail_for(app, site, "flat-c", 3)
    # No in-memory EmailJob is transferred to the replacement worker.
    app.state.worker = ApplicationWorker(
        db, app.state.browser, app.state.executor, Settings(data_dir=app.state.browser.profile_dir.parent)
    )
    db.recover_interrupted()
    assert run_next(app)["status"] == ApplicationStatus.COMPLETED
    assert run_next(app)["status"] == ApplicationStatus.COMPLETED
    assert submissions == {"flat-a": 1, "flat-b": 1, "flat-c": 1}
    assert confirmations == {"flat-a": 1, "flat-b": 1, "flat-c": 1}
    assert db.claim_next_application() is None

    # Provider accepts the POST, but the process loses its local acknowledgement.
    from app.models import ListingPayload

    uncertain = db.create_test(
        db.get_workflow("local", 1),
        ListingPayload(id="flat-uncertain", url=f"{site}/?listing=flat-uncertain"),
        "live-test",
    )
    original_auditor = app.state.worker._auditor

    def interrupted_auditor(*args):
        record = original_auditor(*args)

        def interrupted(step, result, error):
            if result == "submission_sent":
                raise RuntimeError("Lost acknowledgement after provider accepted POST")
            record(step, result, error)

        return interrupted

    with monkeypatch.context() as patch:
        patch.setattr(app.state.worker, "_auditor", interrupted_auditor)
        result = run_next(app)
    assert result["submission_state"] == "intent"
    assert submissions["flat-uncertain"] == 1
    db.recover_interrupted()
    with pytest.raises(ValueError):
        db.resume_application(uncertain)
    assert db.claim_next_application() is None


def test_actual_recorder_extension_tracks_frames_and_exact_version(live_local_app):
    app, client, site, _, _ = live_local_app
    db = app.state.database
    first = flow()
    db.save_workflow(first)
    db.save_workflow(first.model_copy(update={"version": 2, "name": "Newer draft"}))
    post(client, app, "/workflows/local/1/record", example_url=f"{site}/frames")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not db.active_recorder()["ready"]:
        time.sleep(0.05)
    assert db.active_recorder()["ready"], (
        "Chrome must load the actual extension and authenticate its handshake"
    )
    driver = app.state.browser.driver
    for frame in ["one", "two"]:
        driver.switch_to.default_content()
        driver.switch_to.frame(driver.find_element("id", frame))
        driver.find_element("name", "note").send_keys(frame)
        driver.find_element("id", "blur").click()
    driver.switch_to.default_content()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        events = json.loads(db.active_recorder()["events_json"])
        if len(events) >= 4:
            break
        time.sleep(0.05)
    assert len(events) == 4
    root = driver.current_window_handle
    driver.find_element("id", "popup").click()
    app.state.browser.switch_tab(1, 10)
    driver.find_element("name", "note").send_keys("popup")
    driver.find_element("id", "blur").click()
    app.state.browser.switch_tab(0, 10)
    assert driver.current_window_handle == root
    driver.switch_to.frame(driver.find_element("id", "one"))
    driver.find_element("name", "note").send_keys("again")
    driver.find_element("id", "blur").click()
    driver.switch_to.default_content()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        events = json.loads(db.active_recorder()["events_json"])
        if len(events) >= 9:
            break
        time.sleep(0.05)
    assert len(events) == 9
    session_id = db.active_recorder()["id"]
    post(client, app, f"/recorder/{session_id}/stop")
    recorded = db.get_workflow("local", 1)
    assert recorded.enabled and recorded.lifecycle == "active"
    assert db.get_workflow("local", 2).name == "Newer draft"
    assert (
        db.get_workflow("local", 2).definition_hash()
        == first.model_copy(update={"version": 2, "name": "Newer draft"}).definition_hash()
    )
    switches = [step for step in recorded.steps if step.action == "switch_frame"]
    assert len(switches) == 3
    assert switches[0].target.candidates != switches[1].target.candidates
    assert [step.binding.value for step in recorded.steps if step.action == "fill"] == [
        "one",
        "two",
        "popup",
        "oneagain",
    ]
    assert [step.binding.value for step in recorded.steps if step.action == "switch_tab"] == [1, 0]
