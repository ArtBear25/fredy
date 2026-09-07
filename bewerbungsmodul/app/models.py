"""Validated data contracts for Fredy events and recorded workflows."""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator, model_validator


class ApplicationStatus(StrEnum):
    RECEIVED = "received"
    UNSUPPORTED = "unsupported"
    RULE_REJECTED = "rule_rejected"
    QUEUED = "queued"
    RUNNING = "running"
    MANUAL_ACTION = "manual_action"
    EMAIL_PENDING = "email_pending"
    CONFIRMED = "confirmed"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    DRY_RUN_PASSED = "dry_run_passed"


class ListingPayload(BaseModel):
    id: str = Field(min_length=1)
    url: str
    title: str = ""
    description: str = ""
    address: str | None = None
    imageUrl: str | None = None
    fredyUrl: str | None = None
    officialProvider: str | None = None
    providerLink: str | None = None
    applyRequested: bool = False
    applicationTrigger: Literal["auto", "telegram"] | None = None
    callbackUrl: str | None = None
    price: float | None = None
    size: float | None = None
    rooms: float | None = None

    @field_validator("url")
    @classmethod
    def http_url(cls, value: str) -> str:
        parsed = urlparse(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise ValueError("Eine vollständige HTTP(S)-Adresse ohne Zugangsdaten ist erforderlich")
        return value

    @field_validator("providerLink", "callbackUrl")
    @classmethod
    def optional_http_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return cls.http_url(value)

    @field_validator("price", "size", "rooms", mode="before")
    @classmethod
    def number(cls, value: Any) -> float | None:
        from app.rules import as_number

        if value is None or value == "":
            return None
        number = as_number(value)
        if number is None or not math.isfinite(number) or number < 0:
            raise ValueError("Eine nichtnegative Zahl ist erforderlich")
        return number


class FredyEvent(BaseModel):
    event: Literal["listings"] = "listings"
    jobId: str
    provider: str
    timestamp: datetime
    listings: list[ListingPayload]


class FredyPriceChange(BaseModel):
    event: Literal["priceChange"]
    jobId: str
    provider: str
    timestamp: datetime
    priceChanges: list[dict[str, Any]]


class FredyProbe(BaseModel):
    event: Literal["test"]


class LocatorCandidate(BaseModel):
    strategy: Literal["id", "name", "css", "xpath", "label", "role", "testid"]
    value: str
    score: int = Field(default=50, ge=0, le=100)


class ElementTarget(BaseModel):
    candidates: list[LocatorCandidate] = Field(min_length=1)
    tag: str | None = None
    label: str | None = None
    input_type: str | None = None


class ValueBinding(BaseModel):
    source: Literal["literal", "profile", "listing", "secret", "document", "email"] = "literal"
    key: str = ""
    value: str | bool | float | None = None
    format: Literal["none", "date_ddmmyyyy", "digits"] = "none"


class Condition(BaseModel):
    field: str
    operator: Literal[
        "eq",
        "neq",
        "contains",
        "not_contains",
        "exists",
        "gt",
        "gte",
        "lt",
        "lte",
        "matches",
    ]
    value: Any = None

    @model_validator(mode="after")
    def validate_pattern(self) -> Condition:
        if self.operator == "matches":
            validate_regex(str(self.value))
        return self


class RuleGroup(BaseModel):
    mode: Literal["all", "any"] = "all"
    conditions: list[Condition] = Field(default_factory=list)
    groups: list[RuleGroup] = Field(default_factory=list)


class WorkflowStep(BaseModel):
    id: str
    action: Literal[
        "navigate",
        "click",
        "fill",
        "select",
        "check",
        "upload",
        "wait",
        "switch_tab",
        "switch_frame",
        "default_content",
        "assert",
        "email_wait",
    ]
    target: ElementTarget | None = None
    binding: ValueBinding | None = None
    condition: RuleGroup | None = None
    optional: bool = False
    timeout_seconds: int = Field(default=15, ge=1, le=120)
    final_submission: bool = False
    # Human-reviewed classification of a click which only navigates/opens a form.
    non_submitting: bool = False

    @model_validator(mode="after")
    def validate_target(self) -> WorkflowStep:
        needs_target = self.action in {"click", "fill", "select", "check", "upload", "assert", "switch_frame"}
        if needs_target and self.target is None:
            raise ValueError(f"Step {self.id} requires an element target")
        if self.final_submission and self.non_submitting:
            raise ValueError("Ein Schritt kann nicht zugleich absenden und als reine Navigation gelten")
        return self


class EmailTrigger(BaseModel):
    id: str
    sender_pattern: str
    subject_pattern: str = ".*"
    body_pattern: str | None = None
    link_pattern: str | None = None
    allowed_domains: list[str] = Field(default_factory=list)
    continuation_steps: list[WorkflowStep] = Field(default_factory=list)

    @field_validator("allowed_domains")
    @classmethod
    def normalize_domains(cls, domains: list[str]) -> list[str]:
        return WorkflowDefinition.normalize_domains(domains)

    @field_validator("sender_pattern", "subject_pattern", "body_pattern", "link_pattern")
    @classmethod
    def regex(cls, value: str | None) -> str | None:
        if value is not None:
            validate_regex(value)
        return value


class WorkflowDefinition(BaseModel):
    schema_version: Literal[1] = 1
    id: str
    name: str
    provider: str
    version: int = Field(default=1, ge=1)
    enabled: bool = False
    lifecycle: Literal["draft", "recorded", "dry_run_passed", "live_verified", "active"] = "draft"
    allowed_domains: list[str] = Field(min_length=1)
    rules: RuleGroup = Field(default_factory=RuleGroup)
    steps: list[WorkflowStep] = Field(default_factory=list)
    email_triggers: list[EmailTrigger] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("allowed_domains")
    @classmethod
    def normalize_domains(cls, domains: list[str]) -> list[str]:
        normalized = []
        for domain in domains:
            value = domain.strip().lower()
            if value.startswith(("http://", "https://")):
                parsed = urlparse(value)
                if (
                    parsed.username is not None
                    or parsed.password is not None
                    or parsed.port is not None
                    or parsed.path not in {"", "/"}
                    or parsed.params
                    or parsed.query
                    or parsed.fragment
                ):
                    raise ValueError("Domains ohne Zugangsdaten, Port und Pfad angeben")
                # Older drafts accepted website origins in this field. Keep the exact hostname.
                value = parsed.hostname or ""
            value = value.strip(".")
            if not value or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value):
                raise ValueError("Domains ohne Protokoll, Port und Pfad angeben")
            if value and value not in normalized:
                normalized.append(value)
        return normalized

    @model_validator(mode="after")
    def validate_activation(self) -> WorkflowDefinition:
        if self.enabled and self.lifecycle != "active":
            raise ValueError("Only active workflows may be enabled")
        for steps in [self.steps, *(trigger.continuation_steps for trigger in self.email_triggers)]:
            if len({step.id for step in steps}) != len(steps):
                raise ValueError("Schritt-IDs müssen innerhalb eines Ablaufs eindeutig sein")
        if len({trigger.id for trigger in self.email_triggers}) != len(self.email_triggers):
            raise ValueError("E-Mail-Regel-IDs müssen eindeutig sein")
        return self

    def definition_hash(self) -> str:
        """Hash the executable definition, excluding server-owned publication metadata."""
        payload = self.model_dump(mode="json", exclude={"enabled", "lifecycle", "created_at"})
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

    def readiness_errors(self) -> list[str]:
        """Drafts may be incomplete; execution and publication may not be."""
        errors: list[str] = []
        self._check_steps(self.steps, errors, "Bewerbung", require_success=False)
        if not self.steps or self.steps[0].action != "navigate":
            errors.append("Der Ablauf muss mit einer Navigation beginnen")
        if any(step.action == "email_wait" for step in self.steps) and not self.email_triggers:
            errors.append("E-Mail-Wartepunkt ohne E-Mail-Regel")
        if any(step.action == "email_wait" for step in self.steps[:-1]):
            errors.append("Der E-Mail-Wartepunkt muss am Ende des Bewerbungsabschnitts stehen")
        for trigger in self.email_triggers:
            if any(step.action == "email_wait" for step in trigger.continuation_steps):
                errors.append("Eine E-Mail-Fortsetzung muss mit einer Erfolgskontrolle enden")
            self._check_steps(trigger.continuation_steps, errors, trigger.id, require_success=True)
            if not trigger.link_pattern:
                errors.append(f"{trigger.id} — Bestätigungslink-Muster fehlt")
            if not trigger.continuation_steps or trigger.continuation_steps[0].action != "navigate":
                errors.append(f"{trigger.id} — Fortsetzung muss mit einer Navigation beginnen")
            elif not trigger.continuation_steps[0].final_submission:
                errors.append(f"{trigger.id} — Das Öffnen des Bestätigungslinks als Absendegrenze markieren")

        def check_groups(group: RuleGroup) -> None:
            for child in group.groups:
                if not child.conditions and not child.groups:
                    errors.append("Leere Regelgruppe entfernen oder vervollständigen")
                check_groups(child)

        check_groups(self.rules)
        return errors

    @staticmethod
    def _check_steps(
        steps: list[WorkflowStep], errors: list[str], label: str, *, require_success: bool
    ) -> None:
        if not steps:
            errors.append(f"{label} — Schritte fehlen")
            return
        submissions = [i for i, step in enumerate(steps) if step.final_submission]
        for step in steps:
            if step.action in {"navigate", "fill", "select", "check", "upload"} and step.binding is None:
                errors.append(f"{step.id} — Wertzuordnung fehlt")
            if step.final_submission and (step.optional or step.condition):
                errors.append(f"{step.id} — Absenden darf weder optional noch bedingt sein")
            if step.final_submission and step.action not in {"click", "navigate"}:
                errors.append(f"{step.id} — Eine Absendegrenze muss ein Klick oder eine Navigation sein")
        if require_success:
            after = steps[submissions[-1] + 1 :] if submissions else steps
            success = any(
                step.action == "assert"
                and step.binding is not None
                and (step.binding.source != "literal" or step.binding.value not in {None, ""})
                and not step.optional
                and not step.condition
                for step in after
            )
            if not success:
                errors.append(f"{label} — Verbindliche Erfolgskontrolle mit erwartetem Text fehlt")


class ApplicantProfile(BaseModel):
    first_name: str = ""
    last_name: str = ""
    email: str = ""
    phone: str = ""
    street: str = ""
    postcode: str = ""
    city: str = "Berlin"
    household_size: int = Field(default=1, ge=1)
    has_wbs: bool = False
    wbs_type: str = ""
    wbs_rooms: float | None = None
    wbs_valid_until: date | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class RecorderEvent(BaseModel):
    action: str
    url: str
    title: str = ""
    target: ElementTarget | None = None
    value: Any = None
    redacted: bool = False
    opens_new_tab: bool = False
    frame_target: ElementTarget | None = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    session_id: str | None = None
    tab_id: int | None = None
    opener_tab_id: int | None = None
    frame_path: list[ElementTarget] = Field(default_factory=list)


def validate_regex(value: str) -> None:
    if len(value) > 500:
        raise ValueError("Regulärer Ausdruck ist zu lang")
    try:
        re.compile(value)
    except re.error as error:
        raise ValueError(f"Ungültiger regulärer Ausdruck — {error}") from error
