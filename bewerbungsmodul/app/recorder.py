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
        with self.browser.exclusive():
            self.browser.reset_tabs()
            self.database.start_recorder(session_id, workflow.id, workflow.version)
            self.database.set_setting(
                f"recorder.{session_id}",
                {
                    "mode": mode,
                    "trigger_id": trigger_id,
                    "example_url": example_url,
                    "definition_hash": workflow.definition_hash(),
                },
            )
            try:
                self.browser.open(example_url)
            except Exception:
                self.database.stop_recorder(session_id)
                raise
        return session_id

    def receive(self, event: RecorderEvent) -> bool:
        session = self.database.active_recorder()
        if not session:
            return False
        if event.session_id != session["id"] or event.tab_id is None:
            raise ValueError("Ereignis gehört nicht zur aktuellen Aufnahmesitzung")
        workflow = self.database.get_workflow(session["workflow_id"], session["workflow_version"])
        if not workflow or not domain_allowed(event.url, workflow.allowed_domains):
            self.database.audit(
                "recorder_domain_blocked",
                {"url": event.url, "workflow_id": session["workflow_id"]},
            )
            raise ValueError("Recorder event came from an unknown domain")
        allowed_tabs = self.database.get_setting(f"recorder.tabs.{session['id']}", [])
        if (
            session["tab_id"] is not None
            and event.tab_id not in allowed_tabs
            and event.opener_tab_id not in allowed_tabs
        ):
            raise ValueError("Dieses Browserfenster gehört nicht zur Aufnahme")
        if event.tab_id not in allowed_tabs:
            self.database.set_setting(f"recorder.tabs.{session['id']}", [*allowed_tabs, event.tab_id])
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
        raw_events = self.database.stop_recorder(session_id)
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
        current_tab = session["tab_id"]
        for event_data in raw_events:
            event = RecorderEvent.model_validate(event_data)
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
            steps.append(self._to_step(len(steps) + 1, event))
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
