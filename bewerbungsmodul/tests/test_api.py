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
        "listings": [{"id": "one", "url": "https://wbm.de/one", "rooms": 2.5}],
    }
    with TestClient(app) as client:
        assert client.post("/api/v1/fredy/events", json=payload).status_code == 401
        headers = {"Authorization": "Bearer test-token"}
        first = client.post("/api/v1/fredy/events", json=payload, headers=headers)
        second = client.post("/api/v1/fredy/events", json=payload, headers=headers)
        assert first.json() == {"accepted": 1, "duplicates": 0}
        assert second.json() == {"accepted": 0, "duplicates": 1}
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
