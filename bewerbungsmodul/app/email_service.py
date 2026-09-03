"""Read WEB.DE over IMAP without changing message flags and correlate mail safely."""

from __future__ import annotations

import email
import imaplib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from email.header import decode_header, make_header
from email.message import Message
from email.policy import default
from html import unescape
from typing import Any

from app.browser import domain_allowed
from app.database import Database
from app.models import EmailTrigger, WorkflowDefinition
from app.security import SecretStore

LINK_PATTERN = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)


@dataclass(slots=True)
class ParsedMail:
    uid: int
    message_id: str | None
    sender: str
    subject: str
    received_at: str | None
    body: str
    links: list[str]


@dataclass(slots=True)
class MailMatch:
    application: dict[str, Any]
    workflow: WorkflowDefinition
    trigger: EmailTrigger
    link: str | None


def decode_header_value(value: str | None) -> str:
    return str(make_header(decode_header(value or "")))


def parse_message(uid: int, raw: bytes) -> ParsedMail:
    message = email.message_from_bytes(raw, policy=default)
    body = _body_text(message)
    links = []
    for link in LINK_PATTERN.findall(body):
        clean = unescape(link).rstrip(".,);]")
        if clean not in links:
            links.append(clean)
    return ParsedMail(
        uid=uid,
        message_id=message.get("Message-ID"),
        sender=decode_header_value(message.get("From")),
        subject=decode_header_value(message.get("Subject")),
        received_at=message.get("Date"),
        body=body,
        links=links,
    )


def correlate_mail(
    parsed: ParsedMail,
    candidates: list[tuple[dict[str, Any], WorkflowDefinition]],
) -> MailMatch | None:
    matches: list[MailMatch] = []
    haystack = "\n".join([parsed.subject, parsed.body, *parsed.links])
    for application, workflow in candidates:
        listing = json.loads(application["listing_json"])
        for trigger in workflow.email_triggers:
            if re.search(trigger.sender_pattern, parsed.sender, re.IGNORECASE) is None:
                continue
            if re.search(trigger.subject_pattern, parsed.subject, re.IGNORECASE) is None:
                continue
            if trigger.body_pattern and re.search(trigger.body_pattern, parsed.body, re.IGNORECASE) is None:
                continue
            listing_id = str(listing.get("id", ""))
            listing_url = str(listing.get("url", ""))
            identifies_listing = listing_id in haystack or listing_url in haystack
            open_for_provider = application["provider"].casefold() == workflow.provider.casefold()
            if not identifies_listing and not open_for_provider:
                continue
            link = _matching_link(parsed.links, trigger, workflow)
            if trigger.link_pattern and link is None:
                continue
            matches.append(MailMatch(application, workflow, trigger, link))
    return matches[0] if len(matches) == 1 else None


def _matching_link(links: list[str], trigger: EmailTrigger, workflow: WorkflowDefinition) -> str | None:
    allowed = trigger.allowed_domains or workflow.allowed_domains
    matching = [
        link
        for link in links
        if domain_allowed(link, allowed)
        and (not trigger.link_pattern or re.search(trigger.link_pattern, link, re.IGNORECASE))
    ]
    return matching[0] if len(matching) == 1 else None


def _body_text(message: Message) -> str:
    parts: list[str] = []
    for part in message.walk() if message.is_multipart() else [message]:
        content_type = part.get_content_type()
        disposition = part.get_content_disposition()
        if disposition == "attachment" or content_type not in {"text/plain", "text/html"}:
            continue
        try:
            content = part.get_content()
        except (LookupError, UnicodeDecodeError):
            payload = part.get_payload(decode=True) or b""
            content = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        if content_type == "text/html":
            content = re.sub(r"<[^>]+>", " ", content)
        parts.append(unescape(str(content)))
    return re.sub(r"[ \t]+", " ", "\n".join(parts))


class WebDeMailbox:
    host = "imap.web.de"
    port = 993
    mailbox = "INBOX"

    def __init__(self, database: Database, secrets: SecretStore):
        self.database = database
        self.secrets = secrets

    def configured(self) -> bool:
        return bool(self.secrets.get("webde_username") and self.secrets.get("webde_app_password"))

    def poll(self) -> list[ParsedMail]:
        username = self.secrets.get("webde_username")
        password = self.secrets.get("webde_app_password")
        if not username or not password:
            return []
        last_uid = self.database.get_mail_uid(self.mailbox)
        result: list[ParsedMail] = []
        with imaplib.IMAP4_SSL(self.host, self.port) as client:
            client.login(username, password)
            status, _ = client.select(self.mailbox, readonly=True)
            if status != "OK":
                return []
            status, data = client.uid("search", None, f"UID {last_uid + 1}:*")
            if status != "OK" or not data or not data[0]:
                return []
            uids = [int(value) for value in data[0].split()]
            if last_uid == 0:
                uids = uids[-100:]
            for uid in uids:
                status, payload = client.uid("fetch", str(uid), "(BODY.PEEK[])")
                if status != "OK":
                    continue
                raw = next((part[1] for part in payload if isinstance(part, tuple)), None)
                if raw:
                    result.append(parse_message(uid, raw))
                self.database.set_mail_uid(self.mailbox, uid)
        return result

    def store(self, parsed: ParsedMail) -> bool:
        return self.database.save_mail_message(
            {
                "mailbox": self.mailbox,
                "uid": parsed.uid,
                "message_id": parsed.message_id,
                "sender": parsed.sender,
                "subject": parsed.subject,
                "received_at": parsed.received_at,
                "body_text": parsed.body,
                "links_json": json.dumps(parsed.links, ensure_ascii=False),
                "application_id": None,
                "action_status": "unmatched",
                "created_at": datetime.now(UTC).isoformat(),
            }
        )
