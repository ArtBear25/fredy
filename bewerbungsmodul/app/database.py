"""Small SQLite persistence layer with explicit migrations."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from app.models import ApplicantProfile, ApplicationStatus, FredyEvent, WorkflowDefinition

SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflows (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    provider TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS idx_workflows_provider_enabled
    ON workflows(provider, enabled);
CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    listing_json TEXT NOT NULL,
    workflow_id TEXT,
    workflow_version INTEGER,
    status TEXT NOT NULL,
    status_detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    step_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status, created_at);
CREATE TABLE IF NOT EXISTS application_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    outcome TEXT,
    detail TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    FOREIGN KEY(application_id) REFERENCES applications(id)
);
CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER,
    event_type TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    screenshot_path TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(application_id) REFERENCES applications(id)
);
CREATE TABLE IF NOT EXISTS recorder_sessions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    events_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_state (
    mailbox TEXT PRIMARY KEY,
    last_uid INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_messages (
    mailbox TEXT NOT NULL,
    uid INTEGER NOT NULL,
    message_id TEXT,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    received_at TEXT,
    body_text TEXT NOT NULL,
    links_json TEXT NOT NULL,
    application_id INTEGER,
    action_status TEXT NOT NULL DEFAULT 'unmatched',
    created_at TEXT NOT NULL,
    PRIMARY KEY(mailbox, uid)
);
CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    profile_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    document_type TEXT NOT NULL,
    encrypted_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_checks (
    workflow_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    definition_hash TEXT NOT NULL,
    kind TEXT NOT NULL,
    application_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(workflow_id, version, kind)
);
"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        version_table = self._connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'"
        ).fetchone()
        if (
            version_table
            and (self._connection.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] or 0) < 2
        ):
            backup_path = path.with_name(path.stem + ".pre-v2.sqlite3")
            if not backup_path.exists():
                with sqlite3.connect(backup_path) as backup:
                    self._connection.backup(backup)
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self.migrate()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def migrate(self) -> None:
        with self._lock:
            self._connection.executescript(SCHEMA)
            count = self._connection.execute("SELECT COUNT(*) FROM schema_version").fetchone()[0]
            if count == 0:
                self._connection.execute("INSERT INTO schema_version(version) VALUES (1)")
            columns = {
                row["name"] for row in self._connection.execute("PRAGMA table_info(applications)").fetchall()
            }
            if "step_index" not in columns:
                self._connection.execute(
                    "ALTER TABLE applications ADD COLUMN step_index INTEGER NOT NULL DEFAULT 0"
                )
            for name, definition in {
                "mode": "TEXT NOT NULL DEFAULT 'application'",
                "phase": "TEXT NOT NULL DEFAULT 'application'",
                "profile_json": "TEXT",
                "workflow_snapshot": "TEXT",
                "email_json": "TEXT",
                "submission_state": "TEXT NOT NULL DEFAULT 'none'",
                "canonical_url": "TEXT",
                "checkpoint_json": "TEXT",
            }.items():
                if name not in columns:
                    self._connection.execute(f"ALTER TABLE applications ADD COLUMN {name} {definition}")
            recorder_columns = {
                row["name"] for row in self._connection.execute("PRAGMA table_info(recorder_sessions)")
            }
            for name, definition in {
                "workflow_version": "INTEGER",
                "tab_id": "INTEGER",
                "ready": "INTEGER NOT NULL DEFAULT 0",
            }.items():
                if name not in recorder_columns:
                    self._connection.execute(f"ALTER TABLE recorder_sessions ADD COLUMN {name} {definition}")
            for row in self._connection.execute(
                "SELECT id, listing_json FROM applications WHERE canonical_url IS NULL"
            ).fetchall():
                self._connection.execute(
                    "UPDATE applications SET canonical_url=? WHERE id=?",
                    (canonical_url(json.loads(row["listing_json"])["url"]), row["id"]),
                )
            # Old releases stored trusted lifecycle claims in imported JSON. Preserve definitions,
            # but require real evidence before enabling them under the corrected execution contract.
            if self._connection.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] < 2:
                self._connection.execute(
                    "UPDATE applications SET status='manual_action',submission_state='intent',"
                    "status_detail=? WHERE status IN "
                    "('queued','running','manual_action','failed','confirmed','email_pending')",
                    (
                        "Alter Versuch ohne verlässlichen Versandnachweis. "
                        "Ergebnis vor dem Fortsetzen manuell prüfen",
                    ),
                )
                for row in self._connection.execute(
                    "SELECT id, version, definition_json FROM workflows"
                ).fetchall():
                    payload = json.loads(row["definition_json"])
                    payload.update(enabled=False, lifecycle="recorded" if payload.get("steps") else "draft")
                    self._connection.execute(
                        "UPDATE workflows SET enabled=0, definition_json=? WHERE id=? AND version=?",
                        (json.dumps(payload), row["id"], row["version"]),
                    )
                self._connection.execute("UPDATE schema_version SET version=2")
            self._connection.commit()

    def save_workflow(self, workflow: WorkflowDefinition) -> None:
        """Save an editable definition. Imported lifecycle claims never grant execution rights."""
        workflow = WorkflowDefinition.model_validate(workflow.model_dump())
        with self._lock:
            existing = self._connection.execute(
                "SELECT enabled, definition_json FROM workflows WHERE id = ? AND version = ?",
                (workflow.id, workflow.version),
            ).fetchone()
            if existing:
                saved = WorkflowDefinition.model_validate_json(existing["definition_json"])
                if existing["enabled"] or saved.lifecycle == "active":
                    raise ValueError("Active workflow versions are immutable")
            changed = not existing or saved.definition_hash() != workflow.definition_hash()
            if changed:
                self._connection.execute(
                    "DELETE FROM workflow_checks WHERE workflow_id=? AND version=?",
                    (workflow.id, workflow.version),
                )
            lifecycle = ("recorded" if workflow.steps else "draft") if changed else saved.lifecycle
            workflow = workflow.model_copy(update={"enabled": False, "lifecycle": lifecycle})
            self._connection.execute(
                """INSERT INTO workflows(id, version, provider, enabled, definition_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id, version) DO UPDATE SET
                     provider=excluded.provider,
                     enabled=excluded.enabled,
                     definition_json=excluded.definition_json""",
                (
                    workflow.id,
                    workflow.version,
                    workflow.provider,
                    int(workflow.enabled),
                    workflow.model_dump_json(),
                    workflow.created_at.isoformat(),
                ),
            )
            self._connection.commit()

    def delete_workflow_draft(self, workflow_id: str, version: int) -> bool:
        """Delete an unused, non-active workflow version, including failed recorder residue."""
        with self._lock:
            row = self._connection.execute(
                "SELECT enabled, definition_json FROM workflows WHERE id=? AND version=?",
                (workflow_id, version),
            ).fetchone()
            if row is None:
                return False
            workflow = WorkflowDefinition.model_validate_json(row["definition_json"])
            if row["enabled"] or workflow.lifecycle == "active":
                raise ValueError("Aktive Workflow-Versionen können nicht gelöscht werden")
            if self._connection.execute(
                "SELECT 1 FROM applications WHERE workflow_id=? AND workflow_version=? LIMIT 1",
                (workflow_id, version),
            ).fetchone():
                raise ValueError("Workflow-Version wird bereits von einer Bewerbung verwendet")
            if self._connection.execute(
                "SELECT 1 FROM recorder_sessions WHERE workflow_id=? AND workflow_version=? "
                "AND active=1 LIMIT 1",
                (workflow_id, version),
            ).fetchone():
                raise ValueError("Workflow-Aufnahme läuft noch")
            self._connection.execute(
                "DELETE FROM workflow_checks WHERE workflow_id=? AND version=?", (workflow_id, version)
            )
            self._connection.execute(
                "DELETE FROM recorder_sessions WHERE workflow_id=? AND workflow_version=? AND active=0",
                (workflow_id, version),
            )
            cursor = self._connection.execute(
                "DELETE FROM workflows WHERE id=? AND version=?", (workflow_id, version)
            )
            self._connection.commit()
            return cursor.rowcount == 1

    def record_check(self, application_id: int) -> None:
        """Only a finished, audited run of the unchanged snapshot can grant test evidence."""
        application = self.get_application(application_id)
        if not application or application["mode"] not in {"dry-run", "live-test"}:
            return
        required = (
            ApplicationStatus.DRY_RUN_PASSED
            if application["mode"] == "dry-run"
            else ApplicationStatus.COMPLETED
        )
        if application["status"] != required:
            return
        workflow = self.get_workflow(application["workflow_id"], application["workflow_version"])
        snapshot = WorkflowDefinition.model_validate_json(application["workflow_snapshot"])
        if not workflow or workflow.definition_hash() != snapshot.definition_hash():
            return
        attempts = self.application_attempts(application_id)
        if not attempts or attempts[-1]["outcome"] != required:
            raise ValueError("Abgeschlossener Testversuch fehlt")
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT OR REPLACE INTO workflow_checks VALUES (?, ?, ?, ?, ?, ?)",
                (
                    workflow.id,
                    workflow.version,
                    workflow.definition_hash(),
                    application["mode"],
                    application_id,
                    _now(),
                ),
            )
            lifecycle = "live_verified" if self.has_check(workflow, "live-test") else "dry_run_passed"
            if workflow.lifecycle == "active":
                lifecycle = "active"
            updated = workflow.model_copy(update={"lifecycle": lifecycle})
            self._connection.execute(
                "UPDATE workflows SET definition_json=? WHERE id=? AND version=?",
                (updated.model_dump_json(), workflow.id, workflow.version),
            )

    def has_check(self, workflow: WorkflowDefinition, kind: str) -> bool:
        return (
            self._connection.execute(
                (
                    "SELECT 1 FROM workflow_checks WHERE workflow_id=? AND version=? "
                    "AND definition_hash=? AND kind=?"
                ),
                (workflow.id, workflow.version, workflow.definition_hash(), kind),
            ).fetchone()
            is not None
        )

    def activate_workflow(self, workflow_id: str, version: int) -> None:
        with self._lock, self._connection:
            workflow = self.get_workflow(workflow_id, version)
            if not workflow:
                raise ValueError("Workflow fehlt")
            if errors := workflow.readiness_errors():
                raise ValueError("; ".join(errors))
            self._connection.execute(
                "UPDATE workflows SET enabled=0 WHERE lower(provider)=lower(?)",
                (workflow.provider,),
            )
            active = workflow.model_copy(update={"enabled": True, "lifecycle": "active"})
            self._connection.execute(
                "UPDATE workflows SET enabled=1, definition_json=? WHERE id=? AND version=?",
                (active.model_dump_json(), workflow_id, version),
            )
        self.audit("workflow_activated", {"workflow_id": workflow_id, "version": version})

    def deactivate_workflow(self, workflow_id: str, version: int) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE workflows SET enabled=0 WHERE id=? AND version=?", (workflow_id, version)
            )
        self.audit("workflow_deactivated", {"workflow_id": workflow_id, "version": version})

    @staticmethod
    def _workflow_row(row) -> WorkflowDefinition:
        workflow = WorkflowDefinition.model_validate_json(row["definition_json"])
        return workflow.model_copy(update={"enabled": bool(row["enabled"])})

    def list_workflows(self) -> list[WorkflowDefinition]:
        rows = self._connection.execute(
            "SELECT enabled, definition_json FROM workflows ORDER BY provider, id, version DESC"
        ).fetchall()
        return [self._workflow_row(row) for row in rows]

    def get_workflow(self, workflow_id: str, version: int | None = None) -> WorkflowDefinition | None:
        if version is None:
            row = self._connection.execute(
                "SELECT enabled, definition_json FROM workflows WHERE id = ? ORDER BY version DESC LIMIT 1",
                (workflow_id,),
            ).fetchone()
        else:
            row = self._connection.execute(
                "SELECT enabled, definition_json FROM workflows WHERE id = ? AND version = ?",
                (workflow_id, version),
            ).fetchone()
        return self._workflow_row(row) if row else None

    def active_workflow(self, provider: str) -> WorkflowDefinition | None:
        rows = self._connection.execute(
            """SELECT enabled, definition_json FROM workflows
               WHERE lower(provider) = lower(?) AND enabled = 1
               ORDER BY version DESC""",
            (provider,),
        ).fetchall()
        return self._workflow_row(rows[0]) if len(rows) == 1 else None

    def ingest_event(self, event: FredyEvent) -> tuple[int, int]:
        inserted = 0
        duplicates = 0
        now = _now()
        with self._lock:
            for listing in event.listings:
                has_direct_route = bool(listing.officialProvider and listing.providerLink)
                provider = (
                    listing.officialProvider.strip().casefold()
                    if has_direct_route
                    else event.provider.strip().casefold()
                )
                key = f"{provider}:{listing.id}"
                application_url = listing.providerLink if has_direct_route else listing.url
                url = canonical_url(application_url)
                if self._connection.execute(
                    (
                        "SELECT 1 FROM applications WHERE lower(provider)=? AND "
                        "canonical_url=? AND mode!='dry-run'"
                    ),
                    (provider, url),
                ).fetchone():
                    duplicates += 1
                    continue
                try:
                    self._connection.execute(
                        """INSERT INTO applications(
                               idempotency_key, provider, listing_id, listing_json,
                               status, created_at, updated_at, canonical_url
                           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            key,
                            provider,
                            listing.id,
                            listing.model_dump_json(),
                            ApplicationStatus.RECEIVED,
                            now,
                            now,
                            url,
                        ),
                    )
                    inserted += 1
                except sqlite3.IntegrityError:
                    duplicates += 1
            self._connection.commit()
        return inserted, duplicates

    def create_test(self, workflow: WorkflowDefinition, listing, mode: str) -> int:
        if mode not in {"dry-run", "live-test"}:
            raise ValueError("Unbekannter Testmodus")
        if errors := workflow.readiness_errors():
            raise ValueError("; ".join(errors))
        if mode == "live-test" and not self.has_check(workflow, "dry-run"):
            raise ValueError("Zuerst einen Dry-Run dieser Version durchführen")
        with self._lock, self._connection:
            url = canonical_url(listing.url)
            if (
                mode == "live-test"
                and self._connection.execute(
                    (
                        "SELECT 1 FROM applications WHERE lower(provider)=? AND "
                        "(canonical_url=? OR listing_id=?) AND mode!='dry-run'"
                    ),
                    (workflow.provider.casefold(), url, listing.id),
                ).fetchone()
            ):
                raise ValueError(
                    "Für diese Wohnung gibt es bereits einen Bewerbungsversuch. Den "
                    "vorhandenen Eintrag prüfen"
                )
            key = (
                f"dry-run:{uuid4().hex}"
                if mode == "dry-run"
                else f"{workflow.provider.casefold()}:{listing.id}"
            )
            cursor = self._connection.execute(
                (
                    "INSERT INTO applications(idempotency_key,provider,listing_id,list"
                    "ing_json,status,created_at,updated_at,mode,canonical_url,workflow"
                    "_id,workflow_version,workflow_snapshot,profile_json) VALUES "
                    "(?,?,?,?,?,?,?,?,?,?,?,?,?)"
                ),
                (
                    key,
                    workflow.provider.casefold(),
                    listing.id,
                    listing.model_dump_json(),
                    ApplicationStatus.RECEIVED,
                    _now(),
                    _now(),
                    mode,
                    url,
                    workflow.id,
                    workflow.version,
                    workflow.model_dump_json(),
                    self.get_profile().model_dump_json(),
                ),
            )
            return int(cursor.lastrowid)

    def pin_application(self, application_id: int, workflow: WorkflowDefinition) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                (
                    "UPDATE applications SET "
                    "workflow_id=?,workflow_version=?,workflow_snapshot=?,profile_json"
                    "=COALESCE(profile_json,?) WHERE id=? AND workflow_snapshot IS "
                    "NULL"
                ),
                (
                    workflow.id,
                    workflow.version,
                    workflow.model_dump_json(),
                    self.get_profile().model_dump_json(),
                    application_id,
                ),
            )

    def checkpoint(
        self,
        application_id: int,
        index: int,
        submission_state: str | None = None,
        browser_state: dict | None = None,
    ) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                (
                    "UPDATE applications SET step_index=?, "
                    "submission_state=COALESCE(?,submission_state), "
                    "checkpoint_json=COALESCE(?,checkpoint_json), updated_at=? WHERE "
                    "id=?"
                ),
                (
                    index,
                    submission_state,
                    json.dumps(browser_state) if browser_state else None,
                    _now(),
                    application_id,
                ),
            )

    def recover_interrupted(self) -> None:
        """Never replay a possibly sent form after an unclean shutdown."""
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE applications SET status=?,status_detail=?,updated_at=? WHERE status IN (?,?)",
                (
                    ApplicationStatus.MANUAL_ACTION,
                    "Ausführung wurde unterbrochen. Vor dem Fortsetzen Versandstatus und Browser prüfen",
                    _now(),
                    ApplicationStatus.QUEUED,
                    ApplicationStatus.RUNNING,
                ),
            )
            self._connection.execute(
                "UPDATE application_attempts SET outcome=?,detail=?,finished_at=? WHERE finished_at IS NULL",
                (ApplicationStatus.MANUAL_ACTION, "Prozess unterbrochen", _now()),
            )
            self._connection.execute("UPDATE recorder_sessions SET active=0")

    def resume_application(self, application_id: int, *, resolution: str = "resume") -> None:
        with self._lock, self._connection:
            application = self.get_application(application_id)
            if not application or application["status"] not in {
                ApplicationStatus.MANUAL_ACTION,
                ApplicationStatus.FAILED,
                ApplicationStatus.UNSUPPORTED,
                ApplicationStatus.RULE_REJECTED,
            }:
                raise ValueError("Dieser Eintrag wartet nicht auf eine manuelle Entscheidung")
            if resolution == "completed":
                self.update_application(
                    application_id,
                    ApplicationStatus.COMPLETED,
                    "Nutzer hat den externen Erfolg manuell bestätigt",
                )
            elif resolution == "cancel":
                self.update_application(application_id, ApplicationStatus.CANCELLED, "Vom Nutzer abgebrochen")
            elif resolution == "resume":
                if application["submission_state"] == "intent":
                    raise ValueError(
                        "Versandstatus unklar. Externen Erfolg prüfen oder ausdrücklich "
                        "bestätigen, dass nichts abgesendet wurde"
                    )
                self.update_application(application_id, ApplicationStatus.RECEIVED, "Manuell fortgesetzt")
            elif resolution == "not-sent":
                self.checkpoint(application_id, 0, "none")
                self.update_application(
                    application_id,
                    ApplicationStatus.RECEIVED,
                    "Nutzer bestätigt, dass dieser Abschnitt nichts abgesendet hat",
                )
            elif resolution == "refresh-profile":
                if application["submission_state"] != "none":
                    raise ValueError(
                        "Nach einem möglichen Versand kann das Profil dieses Versuchs nicht ersetzt werden"
                    )
                self._connection.execute(
                    "UPDATE applications SET profile_json=?,step_index=0,checkpoint_json=NULL WHERE id=?",
                    (self.get_profile().model_dump_json(), application_id),
                )
                self.update_application(
                    application_id,
                    ApplicationStatus.RECEIVED,
                    "Aktuelles Profil vor dem ersten Versand übernommen",
                )
            else:
                raise ValueError("Unbekannte Entscheidung")
        self.audit("manual_resolution", {"resolution": resolution}, application_id)

    def claim_next_application(self, application_id: int | None = None) -> dict[str, Any] | None:
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            row = self._connection.execute(
                (
                    "SELECT * FROM applications WHERE status = ? AND (? IS NULL OR "
                    "id=?) ORDER BY created_at LIMIT 1"
                ),
                (ApplicationStatus.RECEIVED, application_id, application_id),
            ).fetchone()
            if row is None:
                self._connection.commit()
                return None
            self._connection.execute(
                "UPDATE applications SET status = ?, updated_at = ? WHERE id = ?",
                (ApplicationStatus.QUEUED, _now(), row["id"]),
            )
            self._connection.commit()
            result = dict(row)
            result["status"] = ApplicationStatus.QUEUED
            return result

    def update_application(
        self,
        application_id: int,
        status: ApplicationStatus,
        detail: str | None = None,
        workflow: WorkflowDefinition | None = None,
    ) -> None:
        params = {
            "id": application_id,
            "status": status,
            "detail": detail,
            "updated": _now(),
            "workflow_id": workflow.id if workflow else None,
            "workflow_version": workflow.version if workflow else None,
        }
        with self._lock:
            self._connection.execute(
                """UPDATE applications
                   SET status=:status, status_detail=:detail, updated_at=:updated,
                       workflow_id=COALESCE(:workflow_id, workflow_id),
                       workflow_version=COALESCE(:workflow_version, workflow_version)
                   WHERE id=:id""",
                params,
            )
            self._connection.commit()

    def update_step_index(self, application_id: int, step_index: int) -> None:
        with self._lock:
            self._connection.execute(
                "UPDATE applications SET step_index = ?, updated_at = ? WHERE id = ?",
                (step_index, _now(), application_id),
            )
            self._connection.commit()

    def start_attempt(self, application_id: int, kind: str) -> int:
        with self._lock:
            cursor = self._connection.execute(
                """INSERT INTO application_attempts(application_id, kind, started_at)
                   VALUES (?, ?, ?)""",
                (application_id, kind, _now()),
            )
            self._connection.commit()
            return int(cursor.lastrowid)

    def finish_attempt(self, attempt_id: int, outcome: str, detail: str | None = None) -> None:
        with self._lock:
            self._connection.execute(
                """UPDATE application_attempts
                   SET outcome = ?, detail = ?, finished_at = ? WHERE id = ?""",
                (outcome, detail, _now(), attempt_id),
            )
            self._connection.commit()

    def application_attempts(self, application_id: int) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            """SELECT * FROM application_attempts
               WHERE application_id = ? ORDER BY started_at""",
            (application_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def audit(
        self,
        event_type: str,
        detail: dict[str, Any],
        application_id: int | None = None,
        screenshot_path: str | None = None,
    ) -> None:
        redacted = _redact(detail)
        with self._lock:
            self._connection.execute(
                """INSERT INTO audit_events(
                       application_id, event_type, detail_json, screenshot_path, created_at
                   ) VALUES (?, ?, ?, ?, ?)""",
                (
                    application_id,
                    event_type,
                    json.dumps(redacted, ensure_ascii=False),
                    screenshot_path,
                    _now(),
                ),
            )
            self._connection.commit()

    def recent_applications(self, limit: int = 100) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            "SELECT * FROM applications ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(row) for row in rows]

    def get_application(self, application_id: int) -> dict[str, Any] | None:
        row = self._connection.execute(
            "SELECT * FROM applications WHERE id = ?", (application_id,)
        ).fetchone()
        return dict(row) if row else None

    def audit_events(self, application_id: int | None = None, limit: int = 200) -> list[dict[str, Any]]:
        if application_id is None:
            rows = self._connection.execute(
                "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        else:
            rows = self._connection.execute(
                "SELECT * FROM audit_events WHERE application_id = ? ORDER BY created_at LIMIT ?",
                (application_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def application_counts(self) -> dict[str, int]:
        rows = self._connection.execute(
            "SELECT status, COUNT(*) AS count FROM applications GROUP BY status"
        ).fetchall()
        return {row["status"]: row["count"] for row in rows}

    def get_profile(self) -> ApplicantProfile:
        row = self._connection.execute("SELECT profile_json FROM profile WHERE id = 1").fetchone()
        return ApplicantProfile.model_validate_json(row[0]) if row else ApplicantProfile()

    def save_profile(self, profile: ApplicantProfile) -> None:
        with self._lock:
            self._connection.execute(
                """INSERT INTO profile(id, profile_json, updated_at) VALUES (1, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     profile_json=excluded.profile_json, updated_at=excluded.updated_at""",
                (profile.model_dump_json(), _now()),
            )
            self._connection.commit()

    def start_recorder(self, session_id: str, workflow_id: str, version: int) -> None:
        now = _now()
        with self._lock:
            if self.active_recorder():
                raise ValueError("Es läuft bereits eine Aufnahme")
            self._connection.execute(
                """INSERT INTO recorder_sessions(
                       id, workflow_id, workflow_version, active, events_json, created_at, updated_at
                   ) VALUES (?, ?, ?, 1, '[]', ?, ?)""",
                (session_id, workflow_id, version, now, now),
            )
            self._connection.commit()

    def recorder_ready(self, session_id: str, tab_id: int) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                ("UPDATE recorder_sessions SET ready=1,tab_id=COALESCE(tab_id,?) WHERE id=? AND active=1"),
                (tab_id, session_id),
            )

    def active_recorder(self) -> dict[str, Any] | None:
        row = self._connection.execute(
            "SELECT * FROM recorder_sessions WHERE active = 1 ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None

    def append_recorder_event(self, event: dict[str, Any]) -> bool:
        with self._lock:
            session = self.active_recorder()
            if not session:
                return False
            events = json.loads(session["events_json"])
            events.append(event)
            self._connection.execute(
                "UPDATE recorder_sessions SET events_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(events, ensure_ascii=False), _now(), session["id"]),
            )
            self._connection.commit()
            return True

    def stop_recorder(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            row = self._connection.execute(
                "SELECT events_json FROM recorder_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            self._connection.execute(
                "UPDATE recorder_sessions SET active = 0, updated_at = ? WHERE id = ?",
                (_now(), session_id),
            )
            self._connection.commit()
        return json.loads(row[0]) if row else []

    def recorder_session(self, session_id: str) -> dict[str, Any] | None:
        row = self._connection.execute(
            "SELECT * FROM recorder_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        return dict(row) if row else None

    def list_documents(self) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            """SELECT id, display_name, document_type, sha256, expires_at, created_at
               FROM documents ORDER BY document_type"""
        ).fetchall()
        return [dict(row) for row in rows]

    def save_document_metadata(self, metadata: dict[str, Any]) -> None:
        with self._lock:
            self._connection.execute(
                """INSERT INTO documents(
                       id, display_name, document_type, encrypted_path,
                       sha256, expires_at, created_at
                   ) VALUES (
                       :id, :display_name, :document_type, :encrypted_path,
                       :sha256, :expires_at, :created_at
                   )""",
                metadata,
            )
            self._connection.commit()

    def get_document(self, document_id: str) -> dict[str, Any] | None:
        row = self._connection.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        return dict(row) if row else None

    def get_document_by_reference(self, reference: str) -> dict[str, Any] | None:
        document = self.get_document(reference)
        if document:
            return document
        row = self._connection.execute(
            """SELECT * FROM documents WHERE document_type = ?
               ORDER BY created_at DESC LIMIT 1""",
            (reference.casefold(),),
        ).fetchone()
        return dict(row) if row else None

    def get_mail_uid(self, mailbox: str) -> int:
        row = self._connection.execute(
            "SELECT last_uid FROM mail_state WHERE mailbox = ?", (mailbox,)
        ).fetchone()
        return int(row[0]) if row else 0

    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self._connection.execute("SELECT value_json FROM app_settings WHERE key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        with self._lock:
            self._connection.execute(
                """INSERT INTO app_settings(key, value_json, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                     value_json=excluded.value_json, updated_at=excluded.updated_at""",
                (key, json.dumps(value, ensure_ascii=False), _now()),
            )
            self._connection.commit()

    def set_mail_uid(self, mailbox: str, uid: int) -> None:
        with self._lock:
            self._connection.execute(
                """INSERT INTO mail_state(mailbox, last_uid, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT(mailbox) DO UPDATE SET
                     last_uid=excluded.last_uid, updated_at=excluded.updated_at""",
                (mailbox, uid, _now()),
            )
            self._connection.commit()

    def save_mail_message(self, message: dict[str, Any]) -> bool:
        with self._lock:
            cursor = self._connection.execute(
                """INSERT OR IGNORE INTO mail_messages(
                       mailbox, uid, message_id, sender, subject, received_at, body_text,
                       links_json, application_id, action_status, created_at
                   ) VALUES (
                       :mailbox, :uid, :message_id, :sender, :subject, :received_at, :body_text,
                       :links_json, :application_id, :action_status, :created_at
                   )""",
                message,
            )
            self._connection.commit()
            return cursor.rowcount == 1

    def update_mail_match(self, mailbox: str, uid: int, application_id: int | None, status: str) -> None:
        with self._lock:
            self._connection.execute(
                """UPDATE mail_messages SET application_id = ?, action_status = ?
                   WHERE mailbox = ? AND uid = ?""",
                (application_id, status, mailbox, uid),
            )
            self._connection.commit()

    def recent_mail_messages(self, limit: int = 100) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            "SELECT * FROM mail_messages ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(row) for row in rows]

    def pending_email_applications(self) -> Iterable[dict[str, Any]]:
        rows = self._connection.execute(
            "SELECT * FROM applications WHERE status = ? ORDER BY updated_at DESC",
            (ApplicationStatus.EMAIL_PENDING,),
        ).fetchall()
        return [dict(row) for row in rows]

    def unmatched_mail_messages(self, mailbox: str | None = None) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            "SELECT * FROM mail_messages WHERE action_status='unmatched' "
            "AND (? IS NULL OR mailbox=?) ORDER BY created_at",
            (mailbox, mailbox),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_mail_message(self, mailbox: str, uid: int) -> dict[str, Any] | None:
        row = self._connection.execute(
            "SELECT * FROM mail_messages WHERE mailbox=? AND uid=?", (mailbox, uid)
        ).fetchone()
        return dict(row) if row else None

    def queue_mail(self, application_id: int, mailbox: str, uid: int, payload: dict) -> bool:
        with self._lock, self._connection:
            message = self._connection.execute(
                "SELECT action_status FROM mail_messages WHERE mailbox=? AND uid=?", (mailbox, uid)
            ).fetchone()
            if not message or message["action_status"] != "unmatched":
                return False
            cursor = self._connection.execute(
                (
                    "UPDATE applications SET "
                    "status=?,phase=?,email_json=?,step_index=0,submission_state='none"
                    "',updated_at=? WHERE id=? AND status=?"
                ),
                (
                    ApplicationStatus.RECEIVED,
                    "email:" + payload["trigger_id"],
                    json.dumps(payload),
                    _now(),
                    application_id,
                    ApplicationStatus.EMAIL_PENDING,
                ),
            )
            if cursor.rowcount != 1:
                return False
            self._connection.execute(
                "UPDATE mail_messages SET application_id=?,action_status='queued' WHERE mailbox=? AND uid=?",
                (application_id, mailbox, uid),
            )
            return True


def _redact(value: Any) -> Any:
    secret_words = {"password", "passwort", "secret", "token", "credential", "authorization"}
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if any(word in key.casefold() for word in secret_words) else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def canonical_url(url: str) -> str:
    parsed = urlsplit(url)
    return urlunsplit(
        (parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/") or "/", parsed.query, "")
    )
