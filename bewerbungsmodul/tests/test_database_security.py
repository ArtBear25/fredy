from __future__ import annotations

import io
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.models import ApplicationStatus, FredyEvent, ListingPayload
from app.security import DocumentVault


def _event() -> FredyEvent:
    return FredyEvent(
        jobId="job-1",
        provider="wbm",
        timestamp=datetime.now(UTC),
        listings=[ListingPayload(id="flat-1", url="https://www.wbm.de/flat/1", rooms=2)],
    )


def test_idempotency_and_active_version_immutability(database):
    assert database.ingest_event(_event()) == (1, 0)
    assert database.ingest_event(_event()) == (0, 1)
    from test_regressions import definition, publish

    workflow = definition()
    publish(database, workflow)
    with pytest.raises(ValueError, match="immutable"):
        database.save_workflow(workflow.model_copy(update={"name": "Changed"}))


def test_cancelled_pre_click_attempt_allows_retry_but_sent_attempt_still_blocks(database):
    event = _event()
    assert database.ingest_event(event) == (1, 0)
    first = database.recent_applications(1)[0]
    database.checkpoint(first["id"], 0, "intent")
    database.audit("workflow_step", {"result": "submission_intent"}, first["id"])
    database.audit("workflow_step", {"result": "manual_action"}, first["id"])
    database.update_application(first["id"], ApplicationStatus.CANCELLED, "pre-click failure")

    retry = event.model_copy(
        update={
            "listings": [
                event.listings[0].model_copy(update={"id": "flat-2"})
            ]
        }
    )
    assert database.ingest_event(retry) == (1, 0)

    second = database.recent_applications(1)[0]
    database.checkpoint(second["id"], 0, "intent")
    database.audit("workflow_step", {"result": "submission_intent"}, second["id"])
    database.audit("workflow_step", {"result": "submission_sent"}, second["id"])
    database.update_application(second["id"], ApplicationStatus.CANCELLED, "sent before cancellation")

    third = event.model_copy(
        update={
            "listings": [
                event.listings[0].model_copy(update={"id": "flat-3"})
            ]
        }
    )
    assert database.ingest_event(third) == (0, 1)


def test_active_workflow_can_be_deleted_without_removing_application_history(database):
    from test_regressions import definition, publish

    workflow = definition()
    publish(database, workflow)
    active = database.get_workflow(workflow.id, workflow.version)
    application_id = database.create_test(
        active,
        ListingPayload(id="history-1", url="https://example.test/history-1"),
        "dry-run",
    )

    assert database.delete_workflow(workflow.id, workflow.version)
    assert database.get_workflow(workflow.id, workflow.version) is None
    assert database.get_application(application_id)["listing_id"] == "history-1"


def test_audit_redacts_secrets_and_vault_encrypts(database, secrets, tmp_path: Path):
    database.audit("test", {"password": "visible", "nested": {"authorization": "Bearer abc"}})
    event = database.audit_events()[0]
    assert "visible" not in event["detail_json"]
    assert "Bearer abc" not in event["detail_json"]

    vault = DocumentVault(tmp_path / "vault", tmp_path / "temp", database, secrets)
    document_id = vault.add(io.BytesIO(b"private proof"), "proof.pdf", "wbs")
    metadata = database.get_document(document_id)
    assert b"private proof" not in Path(metadata["encrypted_path"]).read_bytes()
    with vault.materialize(document_id) as path:
        assert path.read_bytes() == b"private proof"
        materialized = path
    assert not materialized.exists()


def test_vault_retries_windows_locked_temp_file(database, secrets, tmp_path: Path, monkeypatch):
    vault = DocumentVault(tmp_path / "vault", tmp_path / "temp", database, secrets)
    document_id = vault.add(io.BytesIO(b"private proof"), "proof.pdf", "wbs")
    original_unlink = Path.unlink
    attempts = 0

    def locked_once(path: Path, *args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise PermissionError("file is still in use")
        return original_unlink(path, *args, **kwargs)

    with vault.materialize(document_id) as path:
        materialized = path
        monkeypatch.setattr(Path, "unlink", locked_once)

    assert attempts == 2
    assert not materialized.exists()
