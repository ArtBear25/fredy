from __future__ import annotations

from app.models import ElementTarget, LocatorCandidate, RecorderEvent
from app.recorder import RecorderService


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
