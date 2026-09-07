from __future__ import annotations

import io
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.models import FredyEvent, ListingPayload
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
