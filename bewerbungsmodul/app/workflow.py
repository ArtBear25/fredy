"""Workflow execution with domain, rule and legal-action guards."""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from selenium.common.exceptions import NoSuchElementException, TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select

from app.browser import AmbiguousTargetError, BrowserController, domain_allowed, looks_legally_binding
from app.models import ValueBinding, WorkflowDefinition, WorkflowStep
from app.rules import evaluate_group, resolve_path
from app.security import DocumentVault, SecretStore


class ManualActionRequired(RuntimeError):
    pass


class WorkflowRejected(RuntimeError):
    pass


@dataclass(slots=True)
class ExecutionResult:
    completed: bool
    email_pending: bool = False
    stopped_before_submit: bool = False
    detail: str = ""


class WorkflowExecutor:
    def __init__(
        self,
        browser: BrowserController,
        secrets_store: SecretStore,
        vault: DocumentVault,
    ):
        self.browser = browser
        self.secrets = secrets_store
        self.vault = vault

    def execute(
        self,
        workflow: WorkflowDefinition,
        context: dict[str, Any],
        *,
        dry_run: bool = False,
        steps: list[WorkflowStep] | None = None,
        audit_callback: Callable[[WorkflowStep, str, str | None], None] | None = None,
        cancel_requested: Callable[[], bool] | None = None,
    ) -> ExecutionResult:
        if errors := workflow.readiness_errors():
            raise ManualActionRequired("; ".join(errors))
        if not evaluate_group(workflow.rules, context):
            raise WorkflowRejected("Workflow rules rejected the listing")
        selected_steps = workflow.steps if steps is None else steps
        # Resolve required data before the first browser side effect in this phase.
        for step in selected_steps:
            if step.action == "email_wait":
                break
            if (
                step.binding
                and evaluate_group(step.condition, context)
                and not step.optional
                and not step.optional_target
            ):
                try:
                    self._resolve_binding(step.binding, context)
                    if step.action == "upload":
                        self.vault.validate(step.binding.key)
                except (ValueError, FileNotFoundError) as error:
                    raise ManualActionRequired(f"{step.id} — {error}") from error
        for step in selected_steps:
            if cancel_requested and cancel_requested():
                raise ManualActionRequired("Verarbeitung wurde angehalten")
            if not evaluate_group(step.condition, context):
                continue
            if dry_run and step.final_submission:
                if audit_callback:
                    audit_callback(step, "dry_run_stop", None)
                return ExecutionResult(
                    completed=False,
                    stopped_before_submit=True,
                    detail=f"Dry run stopped before {step.id}",
                )
            action_performed = False
            try:
                if step.action != "navigate" and self.browser.has_blocked_action_page():
                    raise ManualActionRequired("Contract, payment, cancellation or signature page is blocked")
                if step.action != "navigate":
                    self._assert_current_domain(workflow)
                    if self.browser.has_manual_challenge():
                        raise ManualActionRequired("CAPTCHA oder zusätzliche Anmeldung zuerst manuell prüfen")
                if audit_callback and step.final_submission:
                    audit_callback(step, "submission_intent", None)
                email_pending = self._execute_step(workflow, step, context)
                action_performed = True
                if audit_callback and step.final_submission:
                    audit_callback(step, "submission_sent", None)
                self._assert_current_domain(workflow)
                if self.browser.has_blocked_action_page():
                    raise ManualActionRequired("Contract, payment, cancellation or signature page is blocked")
                if self.browser.has_manual_challenge():
                    raise ManualActionRequired("CAPTCHA or additional login verification detected")
            except (NoSuchElementException, TimeoutException, ValueError, FileNotFoundError) as error:
                if audit_callback:
                    audit_callback(step, "failed", str(error))
                if step.optional and not step.final_submission:
                    continue
                raise ManualActionRequired(f"Schritt {step.id} benötigt eine Prüfung — {error}") from error
            except ManualActionRequired as error:
                if audit_callback:
                    status = "manual_action_after" if action_performed else "manual_action"
                    audit_callback(step, status, str(error))
                raise
            except AmbiguousTargetError as error:
                if audit_callback:
                    audit_callback(step, "manual_action", str(error))
                raise ManualActionRequired(str(error)) from error
            if audit_callback:
                audit_callback(step, "completed", None)
            if email_pending:
                return ExecutionResult(completed=False, email_pending=True, detail="Waiting for email")
        return ExecutionResult(completed=True, detail="Workflow completed")

    def _execute_step(
        self,
        workflow: WorkflowDefinition,
        step: WorkflowStep,
        context: dict[str, Any],
    ) -> bool:
        if step.action == "navigate":
            url = str(self._resolve_binding(step.binding, context))
            if not domain_allowed(url, workflow.allowed_domains):
                raise ManualActionRequired(f"Domain {urlparse(url).hostname} is not allowed")
            self.browser.open(url)
            return False
        if step.action == "wait":
            duration = float(self._resolve_binding(step.binding, context) or 1)
            time.sleep(min(duration, step.timeout_seconds))
            return False
        if step.action == "switch_tab":
            value = self._resolve_binding(step.binding, context)
            if value is not None and (isinstance(value, bool) or not str(value).removesuffix(".0").isdigit()):
                raise ValueError("Tab-Nummer muss eine ganze Zahl ab null sein")
            self.browser.switch_tab(int(float(value)) if value is not None else None, step.timeout_seconds)
            return False
        if step.action == "default_content":
            self.browser.driver.switch_to.default_content()
            return False
        if step.action == "email_wait":
            return True

        try:
            element = (
                self.browser.find(step.target, step.timeout_seconds, allow_hidden=step.action == "upload")
                if step.target
                else None
            )
        except NoSuchElementException:
            if step.optional_target and not step.final_submission:
                return False
            raise
        self._assert_current_domain(workflow)
        if self.browser.has_manual_challenge():
            raise ManualActionRequired("CAPTCHA oder zusätzliche Anmeldung zuerst manuell prüfen")
        if step.action == "switch_frame":
            src = element.get_attribute("src")
            if src and not domain_allowed(src, workflow.allowed_domains):
                raise ManualActionRequired("Frame-Domain ist nicht freigegeben")
            self.browser.driver.switch_to.frame(element)
        elif step.action == "click":
            description = " ".join(
                filter(None, [step.target.label if step.target else None, element.text if element else None])
            )
            if looks_legally_binding(description):
                raise ManualActionRequired("Legally binding action is blocked")
            element.click()
        elif step.action == "fill":
            value = str(self._resolve_binding(step.binding, context))
            element.clear()
            element.send_keys(value)
        elif step.action == "select":
            value = str(self._resolve_binding(step.binding, context))
            try:
                Select(element).select_by_visible_text(value)
            except NoSuchElementException:
                Select(element).select_by_value(value)
        elif step.action == "autocomplete":
            value = str(self._resolve_binding(step.binding, context))
            element.click()
            self._choose_autocomplete_option(element, value, step.timeout_seconds)
        elif step.action == "check":
            expected = self._resolve_binding(step.binding, context)
            if isinstance(expected, str) and expected.casefold() in {"true", "false"}:
                expected = expected.casefold() == "true"
            if not isinstance(expected, bool):
                raise ValueError("Für eine Auswahl ist true oder false erforderlich")
            if element.is_selected() != expected:
                element.click()
        elif step.action == "upload":
            document_id = str(self._resolve_binding(step.binding, context))
            with self.vault.materialize(document_id) as path:
                element.send_keys(str(path))
        elif step.action == "assert":
            expected = self._resolve_binding(step.binding, context)
            if expected is not None and str(expected).casefold() not in element.text.casefold():
                raise ValueError(f"Expected text {expected!r} was not found")
        return False

    def _choose_autocomplete_option(self, element, value: str, timeout_seconds: int) -> None:
        wanted = re.sub(r"\s+", " ", value).strip().casefold()
        deadline = time.monotonic() + timeout_seconds
        typed = False
        started = time.monotonic()
        while time.monotonic() < deadline:
            options = self.browser.driver.find_elements(By.CSS_SELECTOR, "[role='option']")
            matches = [
                option
                for option in options
                if option.is_displayed()
                and re.sub(r"\s+", " ", option.text).strip().casefold() == wanted
            ]
            if len(matches) > 1:
                raise AmbiguousTargetError(f"Auswahl {value!r} ist mehrdeutig")
            if len(matches) == 1:
                matches[0].click()
                return
            if not typed and time.monotonic() - started >= 0.5:
                element.send_keys(value)
                typed = True
            time.sleep(0.1)
        raise NoSuchElementException(f"Auswahl {value!r} wurde nicht gefunden")

    def _assert_current_domain(self, workflow: WorkflowDefinition) -> None:
        current = self.browser.driver.current_url
        if current and current != "data:," and not domain_allowed(current, workflow.allowed_domains):
            raise ManualActionRequired(f"Unexpected domain {urlparse(current).hostname}")
        frame_url = self.browser.driver.execute_script("return location.href")
        if frame_url not in {"about:blank", "about:srcdoc", "data:,"} and not domain_allowed(
            frame_url, workflow.allowed_domains
        ):
            raise ManualActionRequired("Die aktuelle Frame-Domain ist nicht freigegeben")

    def _resolve_binding(self, binding: ValueBinding | None, context: dict[str, Any]) -> Any:
        if binding is None:
            return None
        if binding.source == "literal":
            value = binding.value
        elif binding.source in {"profile", "listing", "email"}:
            value = resolve_path(context, f"{binding.source}.{binding.key}")
        elif binding.source == "secret":
            value = self.secrets.get(binding.key)
            if value is None:
                raise ValueError(f"Secret {binding.key} is missing")
        elif binding.source == "document":
            value = binding.key
        else:
            raise ValueError(f"Unsupported binding source {binding.source}")
        if value is None or value == "":
            raise ValueError(f"Erforderlicher Wert fehlt — {binding.source}.{binding.key}")
        if binding.format == "digits":
            return re.sub(r"\D", "", str(value or ""))
        if binding.format in {"date_ddmmyyyy", "date_dd_mm_yyyy"}:
            try:
                parsed = datetime.fromisoformat(str(value))
            except ValueError as error:
                raise ValueError(f"Value {value!r} is not an ISO date") from error
            return parsed.strftime("%d%m%Y" if binding.format == "date_ddmmyyyy" else "%d.%m.%Y")
        if binding.format in {"street_name", "house_number"}:
            street, house_number = _split_street_address(str(value))
            return street if binding.format == "street_name" else house_number
        if binding.format == "wbs_label":
            text = str(value).strip()
            return text if text.casefold().startswith("wbs ") else f"WBS {text}"
        if binding.format == "wbs_rooms_label":
            try:
                rooms = float(value)
            except (TypeError, ValueError) as error:
                raise ValueError(f"Ungültige WBS-Zimmerzahl {value!r}") from error
            if rooms <= 1.5:
                return "1 Raum oder 1 1/2 und 2 Räume bis zu 50qm"
            if rooms.is_integer() and 2 <= rooms <= 5:
                return f"{int(rooms)} Räume"
            if rooms >= 6:
                return "6 oder mehr Räume"
            raise ValueError(f"Nicht unterstützte WBS-Zimmerzahl {value!r}")
        if binding.source == "literal" and isinstance(value, str):
            return _render_template(value, context)
        return value


def _split_street_address(value: str) -> tuple[str, str]:
    address = value.split(",", 1)[0].strip()
    match = re.fullmatch(r"(.+?)\s+(\d+[a-zA-Z]?(?:[-/]\d+[a-zA-Z]?)?)", address)
    if not match:
        raise ValueError(f"Straße und Hausnummer konnten nicht getrennt werden — {value!r}")
    return match.group(1).strip(), match.group(2).strip()


def screenshot_name(application_id: int, step: str) -> str:
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    safe_step = re.sub(r"[^a-zA-Z0-9_-]", "-", step)[:50]
    return f"{application_id}-{timestamp}-{safe_step}.png"


def _render_template(template: str, context: dict[str, Any]) -> str:
    pattern = re.compile(r"{{\s*((?:profile|listing|email)\.[a-zA-Z0-9_.]+)\s*}}")

    def replace(match: re.Match[str]) -> str:
        value = resolve_path(context, match.group(1))
        if value is None or value == "":
            raise ValueError(f"Erforderlicher Textwert fehlt — {match.group(1)}")
        return str(value)

    return pattern.sub(replace, template)
