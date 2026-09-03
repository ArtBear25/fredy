from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from app.config import Settings
from app.email_service import ParsedMail, correlate_mail
from app.models import (
    ApplicationStatus,
    EmailTrigger,
    FredyEvent,
    ListingPayload,
    ValueBinding,
    WorkflowDefinition,
    WorkflowStep,
)
from app.worker import ApplicationWorker
from app.workflow import ExecutionResult


class FakeBrowser:
    @contextmanager
    def exclusive(self):
        yield

    def screenshot(self, _path):
        return None


class FakeExecutor:
    def __init__(self):
        self.calls = 0

    def execute(self, _workflow, _context, *, steps=None, audit_callback=None, **_kwargs):
        self.calls += 1
        if self.calls == 1:
            return ExecutionResult(completed=False, email_pending=True, detail="Waiting for email")
        return ExecutionResult(completed=True, detail="Confirmed")


def test_fredy_to_email_to_completion_without_external_submission(database, tmp_path: Path):
    continuation = WorkflowStep(
        id="open-confirmation",
        action="navigate",
        binding=ValueBinding(source="email", key="link"),
    )
    workflow = WorkflowDefinition(
        id="wbm",
        name="WBM",
        provider="wbm",
        enabled=True,
        lifecycle="active",
        allowed_domains=["wbm.de"],
        url_patterns=["wbm.de"],
        steps=[WorkflowStep(id="mail", action="email_wait")],
        email_triggers=[
            EmailTrigger(
                id="confirmation",
                sender_pattern="@wbm.de",
                subject_pattern="bestätigen",
                link_pattern="confirm",
                continuation_steps=[continuation],
            )
        ],
    )
    database.save_workflow(workflow)
    event = FredyEvent(
        jobId="fredy-job",
        provider="wbm",
        timestamp=datetime.now(UTC),
        listings=[ListingPayload(id="object-7", url="https://www.wbm.de/object-7", rooms=2)],
    )
    assert database.ingest_event(event) == (1, 0)
    application = database.claim_next_application()
    worker = ApplicationWorker(database, FakeBrowser(), FakeExecutor(), Settings(data_dir=tmp_path))
    worker._process_application(application)
    pending = database.get_application(application["id"])
    assert pending["status"] == ApplicationStatus.EMAIL_PENDING

    mail = ParsedMail(
        uid=9,
        message_id="<9@example>",
        sender="service@wbm.de",
        subject="Bewerbung object-7 bestätigen",
        received_at=datetime.now(UTC).isoformat(),
        body="https://www.wbm.de/confirm/object-7",
        links=["https://www.wbm.de/confirm/object-7"],
    )
    match = correlate_mail(mail, [(pending, workflow)])
    assert match is not None
    worker._process_email(type("Job", (), {"parsed": mail, "match": match})())
    completed = database.get_application(application["id"])
    assert completed["status"] == ApplicationStatus.COMPLETED
    assert json.loads(completed["listing_json"])["rooms"] == 2
