"""Validated data contracts for Fredy events and recorded workflows."""

from __future__ import annotations

from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Any, Literal

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


class ListingPayload(BaseModel):
    id: str
    url: str
    title: str = ""
    description: str = ""
    address: str | None = None
    imageUrl: str | None = None
    fredyUrl: str | None = None
    price: float | str | None = None
    size: float | str | None = None
    rooms: float | str | None = None


class FredyEvent(BaseModel):
    jobId: str
    provider: str
    timestamp: datetime
    listings: list[ListingPayload]


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

    @model_validator(mode="after")
    def validate_target(self) -> WorkflowStep:
        needs_target = self.action in {"click", "fill", "select", "check", "upload", "assert", "switch_frame"}
        if needs_target and self.target is None:
            raise ValueError(f"Step {self.id} requires an element target")
        return self


class EmailTrigger(BaseModel):
    id: str
    sender_pattern: str
    subject_pattern: str = ".*"
    body_pattern: str | None = None
    link_pattern: str | None = None
    allowed_domains: list[str] = Field(default_factory=list)
    continuation_steps: list[WorkflowStep] = Field(default_factory=list)


class WorkflowDefinition(BaseModel):
    schema_version: int = 1
    id: str
    name: str
    provider: str
    version: int = Field(default=1, ge=1)
    enabled: bool = False
    lifecycle: Literal["draft", "recorded", "dry_run_passed", "live_verified", "active"] = "draft"
    allowed_domains: list[str] = Field(min_length=1)
    url_patterns: list[str] = Field(min_length=1)
    rules: RuleGroup = Field(default_factory=RuleGroup)
    steps: list[WorkflowStep] = Field(default_factory=list)
    email_triggers: list[EmailTrigger] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("allowed_domains")
    @classmethod
    def normalize_domains(cls, domains: list[str]) -> list[str]:
        normalized = []
        for domain in domains:
            value = domain.strip().lower().strip(".")
            if value and value not in normalized:
                normalized.append(value)
        return normalized

    @model_validator(mode="after")
    def validate_activation(self) -> WorkflowDefinition:
        if self.enabled and self.lifecycle != "active":
            raise ValueError("Only active workflows may be enabled")
        return self


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
