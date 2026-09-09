from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime

from app.email_service import ParsedMail, correlate_mail, parse_message
from app.models import EmailTrigger, WorkflowDefinition


def _workflow() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="degewo",
        name="degewo",
        provider="degewo",
        allowed_domains=["degewo.de"],
        email_triggers=[
            EmailTrigger(
                id="confirm",
                sender_pattern=r"@degewo\.de",
                subject_pattern="bestätigen",
                link_pattern="confirm",
            )
        ],
    )


def test_parse_and_unique_correlation():
    raw = (
        b"From: Service <noreply@degewo.de>\r\n"
        b"Subject: Bitte bestaetigen flat-42\r\n"
        b"Message-ID: <one@example>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
        b"https://portal.degewo.de/confirm/flat-42"
    )
    parsed = parse_message(7, raw)
    workflow = _workflow().model_copy(
        update={
            "email_triggers": [
                _workflow().email_triggers[0].model_copy(update={"subject_pattern": "bestaetigen"})
            ]
        }
    )
    application = {
        "id": 1,
        "provider": "degewo",
        "listing_json": json.dumps({"id": "flat-42", "url": "https://degewo.de/flat-42"}),
    }
    match = correlate_mail(parsed, [(application, workflow)])
    assert match and match.link == "https://portal.degewo.de/confirm/flat-42"


def test_single_pending_application_does_not_require_listing_reference():
    received_at = datetime.now(UTC).isoformat()
    parsed = ParsedMail(
        uid=2,
        message_id=None,
        sender="noreply@degewo.de",
        subject="bestätigen",
        received_at=received_at,
        body="Bitte bestätigen Sie Ihre Anfrage.",
        links=["https://degewo.de/confirm/token-123"],
    )
    application = {
        "id": 1,
        "provider": "degewo",
        "listing_json": json.dumps({"id": "flat-42", "url": "https://degewo.de/flat-42"}),
        "created_at": received_at,
    }
    match = correlate_mail(parsed, [(application, _workflow())])
    assert match is not None
    assert match.application["id"] == 1
    assert match.link == "https://degewo.de/confirm/token-123"


def test_multiple_pending_applications_without_listing_reference_remain_ambiguous():
    received_at = datetime.now(UTC).isoformat()
    parsed = ParsedMail(
        uid=3,
        message_id=None,
        sender="noreply@degewo.de",
        subject="bestätigen",
        received_at=received_at,
        body="Bitte bestätigen Sie Ihre Anfrage.",
        links=["https://degewo.de/confirm/token-123"],
    )
    applications = [
        {
            "id": 1,
            "provider": "degewo",
            "listing_json": json.dumps({"id": "flat-42", "url": "https://degewo.de/flat-42"}),
            "created_at": received_at,
        },
        {
            "id": 2,
            "provider": "degewo",
            "listing_json": json.dumps({"id": "flat-43", "url": "https://degewo.de/flat-43"}),
            "created_at": received_at,
        },
    ]
    assert correlate_mail(parsed, [(application, _workflow()) for application in applications]) is None


def test_explicit_listing_reference_wins_among_multiple_pending_applications():
    parsed = ParsedMail(
        uid=4,
        message_id=None,
        sender="noreply@degewo.de",
        subject="bestätigen",
        received_at=datetime.now(UTC).isoformat(),
        body="flat-42",
        links=["https://degewo.de/confirm/token-123"],
    )
    applications = [
        {
            "id": 1,
            "provider": "degewo",
            "listing_json": json.dumps({"id": "flat-42", "url": "https://degewo.de/flat-42"}),
        },
        {
            "id": 2,
            "provider": "degewo",
            "listing_json": json.dumps({"id": "flat-43", "url": "https://degewo.de/flat-43"}),
        },
    ]
    match = correlate_mail(parsed, [(application, _workflow()) for application in applications])
    assert match is not None
    assert match.application["id"] == 1


def test_ambiguous_or_unknown_domain_is_not_executed():
    parsed = ParsedMail(
        uid=1,
        message_id=None,
        sender="noreply@degewo.de",
        subject="bestätigen",
        received_at=datetime.now(UTC).isoformat(),
        body="flat-42 https://evil.invalid/confirm/flat-42",
        links=["https://evil.invalid/confirm/flat-42"],
    )
    app = {"id": 1, "provider": "degewo", "listing_json": json.dumps({"id": "flat-42", "url": "x"})}
    assert correlate_mail(parsed, [(app, _workflow())]) is None
    good = replace(parsed, links=["https://degewo.de/confirm/flat-42"])
    assert correlate_mail(good, [(app, _workflow()), ({**app, "id": 2}, _workflow())]) is None


def test_imap_checkpoint_is_after_storage_and_scoped_to_account_and_validity(database, secrets, monkeypatch):
    from app.email_service import WebDeMailbox

    secrets.set("webde_username", "one@example.test")
    secrets.set("webde_app_password", "fake-password")
    raw = b"From: service@example.test\r\nSubject: Confirmation\r\n\r\nhttps://example.test/confirm/a"

    class IMAP:
        validity = 1

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def login(self, *_args):
            pass

        def select(self, *_args, **_kwargs):
            return "OK", []

        def response(self, _name):
            return "UIDVALIDITY", [str(self.validity).encode()]

        def uid(self, command, *args):
            if command == "search":
                return "OK", [b"10"]
            assert "BODY.PEEK[]" in args[1]
            return "OK", [(b'10 (INTERNALDATE "6-Sep-2026 12:00:00 +0000")', raw)]

    server = IMAP()
    monkeypatch.setattr("app.email_service.imaplib.IMAP4_SSL", lambda *args, **kwargs: server)
    mailbox = WebDeMailbox(database, secrets)
    first = mailbox.poll()
    assert len(first) == 1
    assert mailbox.poll() == []  # the IMAP star range still returns the last UID
    assert len(database.unmatched_mail_messages()) == 1
    first_key = mailbox.current_mailbox
    secrets.set("webde_username", "two@example.test")
    assert len(mailbox.poll()) == 1
    assert mailbox.current_mailbox != first_key
    server.validity = 2
    assert len(mailbox.poll()) == 1
    assert len(database.unmatched_mail_messages()) == 3
    assert len(database.unmatched_mail_messages(mailbox.current_mailbox)) == 1


def test_failure_before_checkpoint_does_not_lose_persisted_mail(database, secrets, monkeypatch):
    from app.email_service import WebDeMailbox

    secrets.set("webde_username", "one@example.test")
    secrets.set("webde_app_password", "fake")

    class IMAP:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def login(self, *args):
            pass

        def select(self, *args, **kwargs):
            return "OK", []

        def response(self, name):
            return name, [b"1"]

        def uid(self, command, *args):
            return (
                ("OK", [b"10"])
                if command == "search"
                else (
                    "OK",
                    [
                        (
                            b'10 (INTERNALDATE "6-Sep-2026 12:00:00 +0000")',
                            b"From: a@example.test\r\nSubject: Test\r\n\r\nBody",
                        )
                    ],
                )
            )

    monkeypatch.setattr("app.email_service.imaplib.IMAP4_SSL", lambda *args, **kwargs: IMAP())
    real_checkpoint = database.set_mail_uid

    def interrupted(*args):
        raise RuntimeError("simulated crash")

    monkeypatch.setattr(database, "set_mail_uid", interrupted)
    mailbox = WebDeMailbox(database, secrets)
    import pytest

    with pytest.raises(RuntimeError):
        mailbox.poll()
    assert len(database.unmatched_mail_messages()) == 1
    monkeypatch.setattr(database, "set_mail_uid", real_checkpoint)
    assert mailbox.poll() == []
    assert len(database.unmatched_mail_messages()) == 1
    assert database.get_mail_uid(mailbox.current_mailbox) == 10
