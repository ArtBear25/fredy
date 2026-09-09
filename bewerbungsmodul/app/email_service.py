"""Read WEB.DE over IMAP without changing message flags and correlate mail safely."""

from __future__ import annotations

import email
import hashlib
import imaplib
import json
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from email.header import decode_header, make_header
from email.message import Message
from email.policy import default
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
from typing import Any
from urllib.parse import unquote, urlparse

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
    mailbox: str = "INBOX"


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
    explicit_matches: list[MailMatch] = []
    fallback_matches: list[MailMatch] = []
    haystack = unquote("\n".join([parsed.subject, parsed.body, *parsed.links]))
    for application, workflow in candidates:
        temporal_order_verified = False
        if application.get("created_at"):
            try:
                received = datetime.fromisoformat(parsed.received_at or "")
            except ValueError:
                try:
                    received = parsedate_to_datetime(parsed.received_at or "")
                except (ValueError, TypeError):
                    continue
            if received.tzinfo is None or received < datetime.fromisoformat(application["created_at"]):
                continue
            temporal_order_verified = True
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
            identifies_listing = (
                bool(listing_id) and re.search(r"(?<![\w-])" + re.escape(listing_id) + r"(?![\w-])", haystack)
            ) or (bool(listing_url) and listing_url in haystack)
            link = _matching_link(parsed.links, trigger, workflow)
            needs_link = trigger.link_pattern or any(
                step.binding is not None
                and step.binding.source == "email"
                and step.binding.key == "link"
                for step in trigger.continuation_steps
            )
            if needs_link and link is None:
                continue
            match = MailMatch(application, workflow, trigger, link)
            if identifies_listing:
                explicit_matches.append(match)
            elif temporal_order_verified:
                fallback_matches.append(match)
    # A listing reference is strongest. Without one, pair provider mails with the oldest
    # still-waiting application so confirmations can be processed as a simple queue.
    if len(explicit_matches) == 1:
        return explicit_matches[0]
    if explicit_matches:
        return None
    if not fallback_matches:
        return None
    fallback_matches.sort(key=lambda match: match.application.get("created_at", ""))
    return fallback_matches[0]


def _matching_link(links: list[str], trigger: EmailTrigger, workflow: WorkflowDefinition) -> str | None:
    if not trigger.link_pattern and not trigger.allowed_domains:
        return _automatic_confirmation_link(links, workflow)
    allowed = trigger.allowed_domains or workflow.allowed_domains
    matching = [
        link
        for link in links
        if domain_allowed(link, allowed)
        and (not trigger.link_pattern or re.search(trigger.link_pattern, link, re.IGNORECASE))
    ]
    return matching[0] if len(matching) == 1 else None


def _automatic_confirmation_link(links: list[str], workflow: WorkflowDefinition) -> str | None:
    http_links = [link for link in links if urlparse(link).scheme.casefold() in {"http", "https"}]
    if not http_links:
        return None

    noise = (
        "unsubscribe",
        "abmeld",
        "datenschutz",
        "privacy",
        "impress",
        "facebook",
        "instagram",
        "linkedin",
    )
    useful = [link for link in http_links if not any(word in unquote(link).casefold() for word in noise)]
    candidates = useful or http_links

    hints = {workflow.provider.casefold()}
    for domain in workflow.allowed_domains:
        normalized = domain.casefold().removeprefix("www.")
        hints.add(normalized)
        hints.add(domain.casefold())
    related = [
        link
        for link in candidates
        if any(hint and hint in unquote(link).casefold() for hint in hints)
    ]
    if related:
        return related[0]

    confirmation_words = ("confirm", "bestaet", "bestät", "verify", "aktivier", "bewerb", "anfrag")
    likely = [
        link
        for link in candidates
        if any(word in unquote(link).casefold() for word in confirmation_words)
    ]
    if likely:
        return likely[0]
    return candidates[0]


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
            parser = MailHTMLParser()
            parser.feed(str(content))
            content = " ".join([*parser.text, *parser.links])
        parts.append(unescape(str(content)))
    return re.sub(r"[ \t]+", " ", "\n".join(parts))


class MailHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text: list[str] = []
        self.links: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.links.extend(value for key, value in attrs if key == "href" and value)

    def handle_data(self, data):
        self.text.append(data)


class WebDeMailbox:
    host = "imap.web.de"
    port = 993
    mailbox = "INBOX"

    def __init__(self, database: Database, secrets: SecretStore):
        self.database = database
        self.secrets = secrets
        self.current_mailbox: str | None = None

    def configured(self) -> bool:
        return bool(self.secrets.get("webde_username") and self.secrets.get("webde_app_password"))

    def poll(self) -> list[ParsedMail]:
        self.current_mailbox = None
        username = self.secrets.get("webde_username")
        password = self.secrets.get("webde_app_password")
        if not username or not password:
            return []
        result: list[ParsedMail] = []
        with imaplib.IMAP4_SSL(self.host, self.port, timeout=15) as client:
            client.login(username, password)
            status, _ = client.select(self.mailbox, readonly=True)
            if status != "OK":
                return []
            validity_data = client.response("UIDVALIDITY")[1]
            if not validity_data or not validity_data[0]:
                raise ValueError("IMAP meldet keine UIDVALIDITY")
            validity = int(validity_data[0])
            account = hashlib.sha256(username.strip().casefold().encode()).hexdigest()[:20]
            mailbox_key = f"{account}:{self.mailbox}:{validity}"
            self.current_mailbox = mailbox_key
            last_uid = self.database.get_mail_uid(mailbox_key)
            status, data = client.uid("search", None, f"UID {last_uid + 1}:*")
            if status != "OK" or not data or not data[0]:
                return []
            uids = sorted(int(value) for value in data[0].split() if int(value) > last_uid)
            if last_uid == 0:
                uids = uids[-100:]
            for uid in uids:
                status, payload = client.uid("fetch", str(uid), "(BODY.PEEK[] INTERNALDATE)")
                if status != "OK":
                    break  # do not advance the checkpoint beyond an unpersisted message
                raw = next((part[1] for part in payload if isinstance(part, tuple)), None)
                if raw:
                    parsed = parse_message(uid, raw)
                    parsed.mailbox = mailbox_key
                    metadata = next((part[0] for part in payload if isinstance(part, tuple)), b"")
                    internal_date = imaplib.Internaldate2tuple(metadata)
                    if internal_date:
                        parsed.received_at = datetime.fromtimestamp(
                            time.mktime(internal_date), UTC
                        ).isoformat()
                    if self.store(parsed):
                        result.append(parsed)
                    self.database.set_mail_uid(mailbox_key, uid)
                else:
                    break
        return result

    def store(self, parsed: ParsedMail) -> bool:
        return self.database.save_mail_message(
            {
                "mailbox": parsed.mailbox,
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
