from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_fredy_webhook_auth_rooms_and_idempotency(tmp_path: Path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    payload = {
        "jobId": "job",
        "provider": "wbm",
        "timestamp": "2026-09-02T12:00:00Z",
        "listings": [
            {
                "id": "one",
                "url": "https://wbm.de/one",
                "rooms": 2.5,
                "applyRequested": True,
                "applicationTrigger": "auto",
                "callbackUrl": "http://127.0.0.1:9998/api/application/status/job/one",
            }
        ],
    }
    with TestClient(app) as client:
        assert client.post("/api/v1/fredy/events", json=payload).status_code == 401
        headers = {"Authorization": "Bearer test-token"}
        first = client.post("/api/v1/fredy/events", json=payload, headers=headers)
        second = client.post("/api/v1/fredy/events", json=payload, headers=headers)
        assert first.json() == {"accepted": 1, "duplicates": 0, "ignored": 0}
        assert second.json() == {"accepted": 0, "duplicates": 1, "ignored": 0}
        ignored = client.post(
            "/api/v1/fredy/events",
            json={**payload, "listings": [{"id": "two", "url": "https://wbm.de/two"}]},
            headers=headers,
        )
        assert ignored.json() == {"accepted": 0, "duplicates": 0, "ignored": 1}
        app.state.database.save_profile(
            app.state.database.get_profile().model_copy(update={"has_wbs": True, "wbs_type": "100"})
        )
        discovery = client.get("/api/v1/fredy/discovery")
        assert discovery.status_code == 200
        assert discovery.json() == {
            "service": "fredy-application-module",
            "endpointUrl": "http://testserver/api/v1/fredy/events",
            "authToken": "test-token",
            "applicantWbs": {"hasWbs": True, "type": "100"},
        }
        workflows = client.get("/api/v1/fredy/workflows", headers=headers)
        assert workflows.status_code == 200
        assert isinstance(workflows.json()["providers"], list)
        dashboard = client.get("/")
        assert dashboard.status_code == 200
        assert "WBM Bewerbung" in dashboard.text
        assert "degewo Bewerbung" in dashboard.text
        cors = client.options(
            "/api/v1/recorder/events",
            headers={
                "Origin": "chrome-extension://recorder",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert cors.headers["access-control-allow-origin"] == "chrome-extension://recorder"


def test_simple_email_confirmation_ui_creates_automatic_wait_and_link_opening(tmp_path: Path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(app) as client:
        detail = client.get("/workflows/wbm/1")
        assert detail.status_code == 200
        assert "Absender oder Domain" in detail.text
        assert "Link-Muster" not in detail.text
        assert "Erlaubte Link-Domains" not in detail.text
        assert "email_wait" not in detail.text

        response = client.post(
            "/workflows/wbm/1/email-triggers",
            data={"csrf_token": app.state.csrf_token, "sender_pattern": "service@wbm.de"},
            follow_redirects=False,
        )
        assert response.status_code == 303
        workflow = app.state.database.get_workflow("wbm", 1)
        assert len(workflow.email_triggers) == 1
        trigger = workflow.email_triggers[0]
        assert trigger.sender_pattern == r"service@wbm\.de"
        assert trigger.link_pattern is None
        assert trigger.allowed_domains == []
        assert len(trigger.continuation_steps) == 1
        step = trigger.continuation_steps[0]
        assert step.action == "navigate"
        assert step.binding.source == "email" and step.binding.key == "link"
        assert step.final_submission
        assert workflow.readiness_errors() == []


def test_workflow_detail_exposes_confirmed_delete_and_removes_workflow(tmp_path: Path, secrets):
    app = create_app(Settings(data_dir=tmp_path), start_background=False, secret_store=secrets)
    with TestClient(app) as client:
        detail = client.get("/workflows/wbm/1")
        assert detail.status_code == 200
        assert "Workflow löschen" in detail.text
        assert "Ja, Workflow löschen" in detail.text

        response = client.post(
            "/workflows/wbm/1/delete",
            data={"csrf_token": app.state.csrf_token},
            follow_redirects=False,
        )
        assert response.status_code == 303
        assert response.headers["location"].startswith("/?message=Workflow%20gel%C3%B6scht")
        assert "WBM Bewerbung" not in client.get("/").text
