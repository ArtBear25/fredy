from __future__ import annotations

from app.config import Settings
from app.models import (
    ElementTarget,
    LocatorCandidate,
    RecorderEvent,
    ValueBinding,
    WorkflowDefinition,
    WorkflowStep,
)
from app.recorder import RecorderService, _coalesce_events
from app.worker import ApplicationWorker
from app.workflow import WorkflowExecutor


def test_recorder_redacts_password_and_marks_submit():
    target = ElementTarget(
        candidates=[LocatorCandidate(strategy="name", value="password", score=95)],
        label="Passwort",
        input_type="password",
    )
    password = RecorderService._to_step(
        1, RecorderEvent(action="fill", url="https://x", target=target, redacted=True)
    )
    assert password.binding.source == "secret"
    assert password.binding.key == "passwort"
    assert password.binding.value is None

    submit_target = ElementTarget(
        candidates=[LocatorCandidate(strategy="id", value="submit")],
        label="Bewerbung absenden",
        input_type="submit",
    )
    submit = RecorderService._to_step(2, RecorderEvent(action="click", url="https://x", target=submit_target))
    assert submit.final_submission


def test_recorder_coalesces_consecutive_changes_to_the_same_field():
    target = ElementTarget(
        candidates=[LocatorCandidate(strategy="id", value="powermail_field_wbsgueltigbis", score=98)],
        label="WBS gültig bis",
        input_type="date",
    )
    raw_events = [
        RecorderEvent(
            action="fill",
            url="https://www.wbm.de/x",
            target=target,
            value=value,
            tab_id=1,
        ).model_dump(mode="json")
        for value in ("0002-03-30", "0020-03-30", "0202-03-30", "2027-03-31")
    ]

    events = _coalesce_events(raw_events)

    assert len(events) == 1
    assert events[0].value == "2027-03-31"


def test_recorder_does_not_merge_different_radios_that_share_a_name():
    yes = ElementTarget(
        candidates=[
            LocatorCandidate(strategy="id", value="wbs-yes", score=98),
            LocatorCandidate(strategy="name", value="wbs", score=94),
        ],
        label="ja",
        input_type="radio",
    )
    no = ElementTarget(
        candidates=[
            LocatorCandidate(strategy="id", value="wbs-no", score=98),
            LocatorCandidate(strategy="name", value="wbs", score=94),
        ],
        label="nein",
        input_type="radio",
    )
    raw_events = [
        RecorderEvent(
            action="check",
            url="https://example.test",
            target=target,
            value=True,
            tab_id=1,
        ).model_dump(mode="json")
        for target in (yes, no)
    ]

    events = _coalesce_events(raw_events)

    assert len(events) == 2


def test_recorder_keeps_recorded_values_literal():
    field = RecorderService._to_step(
        1,
        RecorderEvent(
            action="fill",
            url="https://example.test",
            target=ElementTarget(
                candidates=[LocatorCandidate(strategy="id", value="firstName")],
                label="Vorname*",
                input_type="text",
            ),
            value="Artem",
        ),
    )
    assert field.binding.source == "literal"
    assert field.binding.value == "Artem"

    check = RecorderService._to_step(
        2,
        RecorderEvent(
            action="check",
            url="https://example.test",
            target=ElementTarget(
                candidates=[LocatorCandidate(strategy="id", value="wbs-yes")],
                label="ja",
                input_type="radio",
            ),
            value=True,
        ),
    )
    assert check.binding.source == "literal"
    assert check.binding.value is True
    assert check.condition is None


def test_recorder_keeps_document_upload_dynamic():
    upload = RecorderService._to_step(
        1,
        RecorderEvent(
            action="upload",
            url="https://example.test",
            target=ElementTarget(
                candidates=[LocatorCandidate(strategy="id", value="wbs-upload")],
                label="WBS Dokument",
                input_type="file",
            ),
        ),
    )
    assert upload.binding.source == "document"
    assert upload.binding.key == "wbs_dokument"


def test_date_fill_sets_html_date_directly_from_literal():
    class Element:
        def get_attribute(self, name):
            return "date" if name == "type" else None

        def clear(self):
            raise AssertionError("date inputs should not be cleared and typed segment by segment")

        def send_keys(self, value):
            raise AssertionError(f"unexpected send_keys({value!r})")

    class Driver:
        def __init__(self):
            self.value = None

        def execute_script(self, _script, *args):
            if args:
                _element, value = args
                self.value = value

    class Browser:
        def __init__(self):
            self.driver = Driver()
            self.element = Element()

        def find(self, *args, **kwargs):
            return self.element

    browser = Browser()
    executor = WorkflowExecutor(browser, None, None)
    target = ElementTarget(candidates=[LocatorCandidate(strategy="id", value="date")])
    step = WorkflowStep(
        id="date",
        action="fill",
        target=target,
        binding=ValueBinding(source="literal", value="2027-04-01"),
    )
    workflow = WorkflowDefinition(
        id="date-flow",
        name="Date",
        provider="date",
        allowed_domains=["example.test"],
        steps=[step],
    )

    executor._execute_step(workflow, step, {})

    assert browser.driver.value == "2027-04-01"


def test_worker_auditor_skips_expensive_browser_evidence_for_normal_success(tmp_path):
    class AuditDatabase:
        def __init__(self):
            self.checkpoints = []
            self.events = []

        def checkpoint(self, *args, **kwargs):
            self.checkpoints.append((args, kwargs))

        def audit(self, *args, **kwargs):
            self.events.append((args, kwargs))

    class Browser:
        def __init__(self):
            self.state_calls = 0
            self.screenshot_calls = 0

        def state(self):
            self.state_calls += 1
            return {"tab": "x"}

        def screenshot(self, path):
            self.screenshot_calls += 1
            return str(path)

    target = ElementTarget(candidates=[LocatorCandidate(strategy="id", value="name")])
    step = WorkflowStep(
        id="name",
        action="fill",
        target=target,
        binding=ValueBinding(value="x"),
    )
    database = AuditDatabase()
    browser = Browser()
    worker = ApplicationWorker(database, browser, None, Settings(data_dir=tmp_path))
    record = worker._auditor(7, [step])

    record(step, "completed", None)
    assert browser.state_calls == 0
    assert browser.screenshot_calls == 0
    assert database.checkpoints[-1][0] == (7, 1)

    record(step, "failed", "boom")
    assert browser.state_calls == 0
    assert browser.screenshot_calls == 1
    assert database.events[-1][0][3] is not None
