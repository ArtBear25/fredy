"""Turn browser events into editable deterministic workflow steps."""

from __future__ import annotations

import json
import re
import time
import unicodedata
from urllib.parse import urlparse
from uuid import uuid4

from selenium.common.exceptions import WebDriverException

from app.browser import BrowserController
from app.database import Database
from app.models import (
    Condition,
    EmailTrigger,
    RecorderEvent,
    RuleGroup,
    ValueBinding,
    WorkflowDefinition,
    WorkflowStep,
)

_PROFILE_FIELDS = (
    (
        "wbs_valid_until",
        re.compile(r"(?:\bwbs\b.*(?:gultig|gueltig|valid)|(?:gultig|gueltig|valid).*\bwbs\b|wbsgueltigbis)"),
        "none",
    ),
    (
        "wbs_rooms",
        re.compile(r"(?:\bwbs\b.*(?:zimmer|raume|rooms)|(?:zimmer|raume|rooms).*\bwbs\b|wbszimmer)"),
        "none",
    ),
    (
        "wbs_type",
        re.compile(r"(?:\bwbs\b.*(?:art|bezeichnung|type)|(?:art|bezeichnung|type).*\bwbs\b|einkommensgrenze)"),
        "none",
    ),
    ("first_name", re.compile(r"\b(?:vorname|first ?name|given ?name)\b"), "none"),
    ("last_name", re.compile(r"\b(?:nachname|familienname|last ?name|surname)\b"), "none"),
    ("email", re.compile(r"\be ?mail\b"), "none"),
    ("phone", re.compile(r"\b(?:telefon(?:nummer)?|phone|mobile|mobilfunk(?:nummer)?)\b"), "none"),
    ("postcode", re.compile(r"\b(?:plz|postleitzahl|postcode|postal code|zip ?code)\b"), "none"),
    (
        "household_size",
        re.compile(r"\b(?:haushaltsgro(?:sse|esse)|household size|einziehenden personen)\b"),
        "none",
    ),
    ("street", re.compile(r"\b(?:hausnummer|house number|housenumber)\b"), "house_number"),
    ("street", re.compile(r"\b(?:strasse|street)\b"), "none"),
    ("city", re.compile(r"\b(?:ort|stadt|city|wohnort)\b"), "none"),
)


class RecorderService:
    def __init__(self, database: Database, browser: BrowserController):
        self.database = database
        self.browser = browser

    def start(
        self,
        workflow: WorkflowDefinition,
        example_url: str,
        *,
        mode: str = "application",
        trigger_id: str | None = None,
    ) -> str:
        start_domain = _http_domain(example_url)
        session_id = uuid4().hex
        with self.browser.exclusive():
            recorder_started = False
            try:
                self.browser.reset_tabs()
                self.database.start_recorder(session_id, workflow.id, workflow.version)
                recorder_started = True
                self.database.set_setting(
                    f"recorder.{session_id}",
                    {
                        "mode": mode,
                        "trigger_id": trigger_id,
                        "example_url": example_url,
                        "definition_hash": workflow.definition_hash(),
                    },
                )
                self.database.set_setting(f"recorder.domains.{session_id}", [start_domain])
                self.browser.open(example_url)
            except WebDriverException as error:
                if recorder_started:
                    self.database.stop_recorder(session_id)
                raise ValueError("Chrome konnte für die Workflow-Aufnahme nicht geöffnet werden") from error
        return session_id

    def wait_until_ready(self, session_id: str, timeout_seconds: float = 8.0) -> None:
        """Fail early when Chrome's recorder extension never authenticated with this backend."""
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            session = self.database.recorder_session(session_id)
            if not session:
                raise ValueError("Recorder-Sitzung ist nicht mehr vorhanden")
            if session["ready"]:
                return
            if error := self.database.get_setting(f"recorder.error.{session_id}"):
                raise ValueError(f"Recorder-Verbindung fehlgeschlagen — {error}")
            time.sleep(0.05)
        raise ValueError(
            "Chrome-Recorder hat keine Verbindung zu Fredy hergestellt. "
            "Die Aufnahme wurde nicht gestartet; Chrome/Recorder wird beim nächsten Versuch neu geprüft"
        )

    def cancel(self, session_id: str) -> None:
        """Explicitly discard a recording session without touching its workflow definition."""
        if self.database.recorder_session(session_id):
            self.database.stop_recorder(session_id)

    def receive(self, event: RecorderEvent) -> bool:
        session = self.database.active_recorder()
        if not session:
            return False
        if event.session_id != session["id"] or event.tab_id is None:
            raise ValueError("Ereignis gehört nicht zur aktuellen Aufnahmesitzung")
        workflow = self.database.get_workflow(session["workflow_id"], session["workflow_version"])
        if not workflow:
            raise ValueError("Workflow der Aufnahme fehlt")
        domain = _http_domain(event.url)
        allowed_tabs = self.database.get_setting(f"recorder.tabs.{session['id']}", [])
        if (
            session["tab_id"] is not None
            and event.tab_id not in allowed_tabs
            and event.opener_tab_id not in allowed_tabs
        ):
            raise ValueError("Dieses Browserfenster gehört nicht zur Aufnahme")
        if event.tab_id not in allowed_tabs:
            self.database.set_setting(f"recorder.tabs.{session['id']}", [*allowed_tabs, event.tab_id])
        domains = self.database.get_setting(f"recorder.domains.{session['id']}", [])
        if domain not in domains:
            self.database.set_setting(f"recorder.domains.{session['id']}", [*domains, domain])
        if event.action == "ready":
            self.database.recorder_ready(session["id"], event.tab_id)
            return True
        if event.action == "error":
            self.database.set_setting(f"recorder.error.{session['id']}", event.value)
            return True
        if event.redacted:
            event = event.model_copy(update={"value": None})
        return self.database.append_recorder_event(event.model_dump(mode="json"))

    def stop(self, session_id: str) -> WorkflowDefinition:
        session = self.database.recorder_session(session_id)
        if not session:
            raise LookupError("Recorder session not found")
        raw_events = json.loads(session["events_json"] or "[]")
        current = self.database.get_workflow(session["workflow_id"], session["workflow_version"])
        if current is None:
            raise LookupError("Workflow not found")

        if not session["ready"] or not raw_events:
            raise ValueError("Keine vollständige Aufnahme empfangen. Recorder-Verbindung und Browser prüfen")
        steps: list[WorkflowStep] = []
        if recorder_target := self.database.get_setting(f"recorder.{session_id}", {}):
            mode = recorder_target.get("mode")
        else:
            mode = "application"
        if recorder_target.get("definition_hash") != current.definition_hash():
            raise ValueError("Die Workflow-Version wurde während der Aufnahme verändert")
        if error := self.database.get_setting(f"recorder.error.{session_id}"):
            raise ValueError(f"Aufnahme unvollständig — {error}")
        recorded_domains = self.database.get_setting(f"recorder.domains.{session_id}", [])
        if not recorded_domains:
            raise ValueError("Die Aufnahme enthält keine gültige Web-Domain")
        if mode != "email":
            steps.append(
                WorkflowStep(
                    id="open-listing",
                    action="navigate",
                    binding=ValueBinding(source="listing", key="url"),
                )
            )
        frame_path = []
        tabs = self.database.get_setting(f"recorder.tabs.{session_id}", [])
        semantic_steps = [
            step
            for workflow in self.database.list_workflows()
            if workflow.id == current.id
            for step in workflow.steps
            if step.binding and step.binding.source == "profile"
        ]
        profile_values = self.database.get_profile().model_dump(mode="json")
        current_tab = session["tab_id"]
        for event in _coalesce_events(raw_events):
            if event.tab_id != current_tab:
                steps.append(
                    WorkflowStep(
                        id=f"recorded-{len(steps) + 1:03d}-tab",
                        action="switch_tab",
                        binding=ValueBinding(value=tabs.index(event.tab_id)),
                    )
                )
                current_tab = event.tab_id
                frame_path = []
            next_path = event.frame_path or ([event.frame_target] if event.frame_target else [])
            if next_path != frame_path:
                steps.append(
                    WorkflowStep(id=f"recorded-{len(steps) + 1:03d}-default", action="default_content")
                )
                for target in next_path:
                    steps.append(
                        WorkflowStep(
                            id=f"recorded-{len(steps) + 1:03d}-frame", action="switch_frame", target=target
                        )
                    )
                frame_path = next_path
            steps.append(self._to_step(len(steps) + 1, event, semantic_steps, profile_values))
        if recorder_target.get("mode") == "email":
            trigger_id = recorder_target.get("trigger_id")
            triggers: list[EmailTrigger] = []
            for trigger in current.email_triggers:
                if trigger.id == trigger_id:
                    navigate = WorkflowStep(
                        id=f"{trigger.id}-open-link",
                        action="navigate",
                        binding=ValueBinding(source="email", key="link"),
                        final_submission=True,
                    )
                    trigger = trigger.model_copy(update={"continuation_steps": [navigate, *steps]})
                triggers.append(trigger)
            trusted_domains = list(dict.fromkeys([*current.allowed_domains, *recorded_domains]))
            workflow = current.model_copy(
                update={
                    "email_triggers": triggers,
                    "allowed_domains": trusted_domains,
                    "lifecycle": "recorded",
                    "enabled": False,
                }
            )
        else:
            workflow = current.model_copy(
                update={
                    "steps": steps,
                    "allowed_domains": recorded_domains,
                    "lifecycle": "recorded",
                    "enabled": False,
                }
            )
        self.database.save_workflow(workflow)
        if mode != "email":
            self.database.activate_workflow(workflow.id, workflow.version)
        self.database.stop_recorder(session_id)
        return self.database.get_workflow(workflow.id, workflow.version) or workflow

    @staticmethod
    def _to_step(
        index: int,
        event: RecorderEvent,
        semantic_steps: list[WorkflowStep] | None = None,
        profile_values: dict | None = None,
    ) -> WorkflowStep:
        binding = None
        condition = None
        optional = False
        optional_target = False
        timeout_seconds = 15

        if event.action in {"fill", "select", "check"}:
            if event.redacted:
                label = event.target.label if event.target else "password"
                binding = ValueBinding(source="secret", key=_slug(label or "password"))
            elif template := _semantic_template(event, semantic_steps or []):
                binding = template.binding.model_copy(deep=True) if template.binding else None
                condition = template.condition.model_copy(deep=True) if template.condition else None
                optional = template.optional
                optional_target = template.optional_target
                timeout_seconds = template.timeout_seconds
            else:
                inferred = _infer_profile_semantics(event)
                if inferred:
                    binding, condition = inferred
                elif value_binding := _infer_profile_value(event, profile_values or {}):
                    binding = value_binding
                else:
                    binding = ValueBinding(source="literal", value=event.value)
        elif event.action == "upload":
            label = event.target.label if event.target else "document"
            binding = ValueBinding(source="document", key=_slug(label or "document"))

        is_submit = bool(
            event.action == "click"
            and event.target
            and (
                event.target.input_type == "submit"
                or re.search(
                    r"bewerb|absend|submit|interesse|anfrage|versend",
                    event.target.label or "",
                    re.IGNORECASE,
                )
            )
        )
        return WorkflowStep(
            id=f"recorded-{index:03d}",
            action=event.action,
            target=event.target,
            binding=binding,
            condition=condition,
            optional=optional,
            optional_target=optional_target,
            timeout_seconds=timeout_seconds,
            final_submission=is_submit,
        )


def _coalesce_events(raw_events: list[dict]) -> list[RecorderEvent]:
    """Keep only the final state of consecutive edits to the same form field."""
    events: list[RecorderEvent] = []
    for event_data in raw_events:
        event = RecorderEvent.model_validate(event_data)
        if (
            events
            and event.action in {"fill", "select", "check"}
            and events[-1].action == event.action
            and events[-1].tab_id == event.tab_id
            and events[-1].frame_path == event.frame_path
            and _same_target(events[-1].target, event.target)
        ):
            events[-1] = event
        else:
            events.append(event)
    return events


def _semantic_template(event: RecorderEvent, steps: list[WorkflowStep]) -> WorkflowStep | None:
    if not event.target:
        return None
    value_actions = {"fill", "select", "autocomplete"}
    for step in steps:
        if not step.target or not step.binding or step.binding.source != "profile":
            continue
        if step.action != event.action and not ({step.action, event.action} <= value_actions):
            continue
        if _same_target(step.target, event.target):
            return step
    return None


def _same_target(left, right) -> bool:
    if not left or not right:
        return False
    for strategy in ("id", "testid", "name"):
        left_values = _target_values(left, strategy)
        right_values = _target_values(right, strategy)
        if left_values and right_values:
            return bool(left_values.intersection(right_values))
    left_label = _normalize(left.label or "")
    right_label = _normalize(right.label or "")
    if left_label and right_label:
        return left_label == right_label
    return bool(_target_keys(left).intersection(_target_keys(right)))


def _target_values(target, strategy: str) -> set[str]:
    return {
        candidate.value.casefold()
        for candidate in target.candidates
        if candidate.strategy == strategy and candidate.value
    }


def _target_keys(target) -> set[tuple[str, str]]:
    return {
        (candidate.strategy, candidate.value.casefold())
        for candidate in target.candidates
        if candidate.value
    }


def _infer_profile_semantics(
    event: RecorderEvent,
) -> tuple[ValueBinding, RuleGroup | None] | None:
    target = event.target
    if not target:
        return None

    text = _target_text(target)
    input_type = (target.input_type or "").casefold()
    if event.action == "check":
        if re.search(r"(?:\bwbs\b.*(?:vorhanden|available)|wbsvorhanden)", text):
            if input_type == "checkbox":
                return ValueBinding(source="profile", key="has_wbs"), None
            label = _normalize(target.label or "")
            if event.value is True and label in {"ja", "yes", "nein", "no"}:
                expected = label in {"ja", "yes"}
                return ValueBinding(value=True), _profile_condition("has_wbs", expected)
        checkbox_fields = (
            ("has_special_housing_need", "besonderer wohnbedarf"),
            ("age_55_plus", "55"),
        )
        for key, marker in checkbox_fields:
            if input_type == "checkbox" and marker in text:
                return ValueBinding(source="profile", key=key), None
        return None

    if event.action not in {"fill", "select", "autocomplete"}:
        return None

    for key, pattern, value_format in _PROFILE_FIELDS:
        if not pattern.search(text):
            continue
        if key == "wbs_valid_until":
            value_format = _recorded_date_format(event.value)
        condition = _profile_condition("has_wbs", True) if key.startswith("wbs_") else None
        return ValueBinding(source="profile", key=key, format=value_format), condition
    return None


def _recorded_date_format(value) -> str:
    raw = str(value or "").strip()
    if re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", raw):
        return "date_dd_mm_yyyy"
    if re.fullmatch(r"\d{8}", raw):
        return "date_ddmmyyyy"
    return "none"


def _infer_profile_value(event: RecorderEvent, profile: dict) -> ValueBinding | None:
    if event.action not in {"fill", "select", "autocomplete"} or event.value in {None, ""}:
        return None
    recorded = str(event.value).strip()
    matches = []
    for key in ("first_name", "last_name", "email", "phone", "street", "postcode", "city"):
        value = profile.get(key)
        if value not in {None, ""} and recorded.casefold() == str(value).strip().casefold():
            matches.append(key)
    if len(matches) == 1:
        return ValueBinding(source="profile", key=matches[0])
    return None


def _profile_condition(key: str, value: bool) -> RuleGroup:
    return RuleGroup(conditions=[Condition(field=f"profile.{key}", operator="eq", value=value)])


def _target_text(target) -> str:
    values = [target.label or ""]
    values.extend(candidate.value for candidate in target.candidates)
    return _normalize(" ".join(values))


def _normalize(value: str) -> str:
    value = value.replace("ß", "ss")
    decomposed = unicodedata.normalize("NFKD", value)
    plain = "".join(character for character in decomposed if not unicodedata.combining(character))
    return re.sub(r"[^a-z0-9]+", " ", plain.casefold()).strip()


def _slug(value: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "_", value.casefold()).strip("_")
    return result or "value"


def _http_domain(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Eine vollständige HTTP(S)-Adresse ohne Zugangsdaten ist erforderlich")
    return parsed.hostname.casefold().strip(".")
