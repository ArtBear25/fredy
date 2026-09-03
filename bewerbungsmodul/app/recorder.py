"""Turn browser events into editable deterministic workflow steps."""

from __future__ import annotations

import re
from uuid import uuid4

from app.browser import BrowserController, domain_allowed
from app.database import Database
from app.models import EmailTrigger, RecorderEvent, ValueBinding, WorkflowDefinition, WorkflowStep


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
        if not domain_allowed(example_url, workflow.allowed_domains):
            raise ValueError("Example URL is outside the workflow's allowed domains")
        session_id = uuid4().hex
        self.database.save_workflow(workflow)
        self.database.start_recorder(session_id, workflow.id)
        self.database.set_setting(
            f"recorder.{session_id}", {"mode": mode, "trigger_id": trigger_id, "example_url": example_url}
        )
        self.browser.open(example_url)
        return session_id

    def receive(self, event: RecorderEvent) -> bool:
        session = self.database.active_recorder()
        if not session:
            return False
        workflow = self.database.get_workflow(session["workflow_id"])
        if not workflow or not domain_allowed(event.url, workflow.allowed_domains):
            self.database.audit(
                "recorder_domain_blocked",
                {"url": event.url, "workflow_id": session["workflow_id"]},
            )
            raise ValueError("Recorder event came from an unknown domain")
        return self.database.append_recorder_event(event.model_dump(mode="json"))

    def stop(self, session_id: str) -> WorkflowDefinition:
        session = self.database.recorder_session(session_id)
        if not session:
            raise LookupError("Recorder session not found")
        raw_events = self.database.stop_recorder(session_id)
        current = self.database.get_workflow(session["workflow_id"])
        if current is None:
            raise LookupError("Workflow not found")

        if current.enabled:
            current = current.model_copy(update={"version": current.version + 1, "enabled": False})
        steps: list[WorkflowStep] = []
        if recorder_target := self.database.get_setting(f"recorder.{session_id}", {}):
            mode = recorder_target.get("mode")
        else:
            mode = "application"
        if mode != "email":
            steps.append(
                WorkflowStep(
                    id="open-listing",
                    action="navigate",
                    binding=ValueBinding(source="listing", key="url"),
                )
            )
        in_frame = False
        for event_data in raw_events:
            event = RecorderEvent.model_validate(event_data)
            if event.frame_target and not in_frame:
                steps.append(
                    WorkflowStep(
                        id=f"recorded-{len(steps) + 1:03d}-frame",
                        action="switch_frame",
                        target=event.frame_target,
                    )
                )
                in_frame = True
            elif not event.frame_target and in_frame:
                steps.append(
                    WorkflowStep(id=f"recorded-{len(steps) + 1:03d}-default", action="default_content")
                )
                in_frame = False
            steps.append(self._to_step(len(steps) + 1, event))
            if event.opens_new_tab:
                steps.append(WorkflowStep(id=f"recorded-{len(steps) + 1:03d}-tab", action="switch_tab"))
        if recorder_target.get("mode") == "email":
            trigger_id = recorder_target.get("trigger_id")
            triggers: list[EmailTrigger] = []
            for trigger in current.email_triggers:
                if trigger.id == trigger_id:
                    navigate = WorkflowStep(
                        id=f"{trigger.id}-open-link",
                        action="navigate",
                        binding=ValueBinding(source="email", key="link"),
                    )
                    trigger = trigger.model_copy(update={"continuation_steps": [navigate, *steps]})
                triggers.append(trigger)
            workflow = current.model_copy(
                update={"email_triggers": triggers, "lifecycle": "recorded", "enabled": False}
            )
        else:
            workflow = current.model_copy(update={"steps": steps, "lifecycle": "recorded", "enabled": False})
        self.database.save_workflow(workflow)
        return workflow

    @staticmethod
    def _to_step(index: int, event: RecorderEvent) -> WorkflowStep:
        binding = None
        if event.action in {"fill", "select", "check"}:
            if event.redacted:
                label = event.target.label if event.target else "password"
                binding = ValueBinding(source="secret", key=_slug(label or "password"))
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
                or re.search(r"bewerb|absend|submit|interesse", event.target.label or "", re.IGNORECASE)
            )
        )
        return WorkflowStep(
            id=f"recorded-{index:03d}",
            action=event.action,
            target=event.target,
            binding=binding,
            final_submission=is_submit,
        )


def _slug(value: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "_", value.casefold()).strip("_")
    return result or "value"
