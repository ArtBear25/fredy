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
        url_patterns=["degewo.de"],
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
