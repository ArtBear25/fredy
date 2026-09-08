from __future__ import annotations

import io
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app.browser import BrowserController
from app.models import ElementTarget, LocatorCandidate, ValueBinding, WorkflowDefinition, WorkflowStep
from app.security import DocumentVault
from app.workflow import ManualActionRequired, WorkflowExecutor


def target(strategy: str, value: str, label: str = "") -> ElementTarget:
    return ElementTarget(candidates=[LocatorCandidate(strategy=strategy, value=value, score=90)], label=label)


@pytest.fixture(scope="module")
def fixture_server():
    directory = Path(__file__).parent / "fixtures"

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    thread.join(timeout=2)


def test_local_form_tabs_frames_upload_and_broken_locator(fixture_server, database, secrets, tmp_path: Path):
    browser = BrowserController(tmp_path / "chrome", headless=True)
    vault = DocumentVault(tmp_path / "vault", tmp_path / "temp", database, secrets)
    document_id = vault.add(io.BytesIO(b"test document"), "proof.txt", "proof")
    executor = WorkflowExecutor(browser, secrets, vault)
    workflow = WorkflowDefinition(
        id="local",
        name="Local integration",
        provider="local",
        allowed_domains=["127.0.0.1"],
        steps=[
            WorkflowStep(id="open", action="navigate", binding=ValueBinding(source="listing", key="url")),
            WorkflowStep(
                id="name",
                action="fill",
                target=ElementTarget(
                    candidates=[
                        LocatorCandidate(strategy="id", value="old-id", score=100),
                        LocatorCandidate(strategy="name", value="applicant_name", score=90),
                    ]
                ),
                binding=ValueBinding(source="profile", key="first_name"),
            ),
            WorkflowStep(
                id="rooms", action="select", target=target("id", "rooms"), binding=ValueBinding(value="2")
            ),
            WorkflowStep(
                id="wbs", action="check", target=target("id", "wbs"), binding=ValueBinding(value=True)
            ),
            WorkflowStep(
                id="upload",
                action="upload",
                target=target("id", "proof"),
                binding=ValueBinding(source="document", key=document_id),
            ),
            WorkflowStep(id="frame", action="switch_frame", target=target("id", "details-frame")),
            WorkflowStep(
                id="note", action="fill", target=target("name", "note"), binding=ValueBinding(value="Hallo")
            ),
            WorkflowStep(id="default", action="default_content"),
            WorkflowStep(
                id="submit",
                action="click",
                target=target("id", "submit", "Bewerbung absenden"),
                final_submission=True,
            ),
            WorkflowStep(
                id="success",
                action="assert",
                target=target("id", "success"),
                binding=ValueBinding(value="lokal angenommen"),
            ),
            WorkflowStep(id="tab", action="click", target=target("id", "open-tab"), non_submitting=True),
            WorkflowStep(id="switch", action="switch_tab"),
            WorkflowStep(
                id="tab-ready",
                action="assert",
                target=target("id", "tab-ready"),
                binding=ValueBinding(value="Zusatzseite"),
            ),
        ],
    )
    context = {
        "listing": {"url": f"{fixture_server}/form.html"},
        "profile": {"first_name": "Ada"},
        "email": {},
    }
    try:
        result = executor.execute(workflow, context)
        assert result.completed
        assert browser.driver.find_element("id", "tab-ready").is_displayed()

        dry = executor.execute(workflow, context, dry_run=True)
        assert dry.stopped_before_submit

        broken = workflow.model_copy(
            update={
                "steps": [
                    workflow.steps[0],
                    WorkflowStep(
                        id="broken",
                        action="click",
                        target=target("id", "does-not-exist"),
                        timeout_seconds=1,
                        non_submitting=True,
                    ),
                    *workflow.steps[1:],
                ]
            }
        )
        with pytest.raises(ManualActionRequired):
            executor.execute(broken, context)
    finally:
        browser.quit()


def test_discover_live_gewobag_form(tmp_path: Path):
    import os
    import time

    if os.getenv("RUN_GEWOBAG_DISCOVERY") != "1":
        pytest.skip("live discovery only")
    browser = BrowserController(tmp_path / "gewobag-live", headless=True)
    try:
        url = "https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/6011-31046-0301-0272/"
        browser.open(url)
        print("START", browser.driver.current_url, browser.driver.title)
        controls = browser.driver.find_elements("css selector", "button, a, input[type=submit], [role=button]")
        for element in controls:
            text = " ".join(filter(None, [element.text, element.get_attribute("aria-label"), element.get_attribute("value")]))
            if text.strip():
                print("BEFORE_CONTROL", element.tag_name, repr(text), element.get_attribute("id"), element.get_attribute("href"))
        for element in controls:
            text = " ".join(filter(None, [element.text, element.get_attribute("aria-label"), element.get_attribute("value")]))
            if any(marker in text.casefold() for marker in ("alle akzeptieren", "akzeptieren", "zustimmen")) and element.is_displayed():
                print("CONSENT_CONTROL", element.tag_name, text, element.get_attribute("id"))
                element.click()
                time.sleep(1)
                break
        controls = browser.driver.find_elements("css selector", "button, a, input[type=submit], [role=button]")
        for element in controls:
            text = " ".join(filter(None, [element.text, element.get_attribute("aria-label"), element.get_attribute("value")]))
            if "anfrage senden" in text.casefold() and element.is_displayed():
                print("REQUEST_CONTROL", element.tag_name, text, element.get_attribute("href"))
                element.click()
                break
        time.sleep(5)
        print("AFTER", browser.driver.current_url, browser.driver.title, browser.driver.window_handles)
        frames = browser.driver.find_elements("css selector", "iframe, frame")
        for frame_index, frame in enumerate(frames):
            print(
                "FRAME",
                frame_index,
                "id=", frame.get_attribute("id"),
                "name=", frame.get_attribute("name"),
                "title=", frame.get_attribute("title"),
                "src=", frame.get_attribute("src"),
            )
        if frames:
            browser.driver.switch_to.frame(frames[0])
            time.sleep(2)
            print("FRAME_URL", browser.driver.execute_script("return location.href"))
            for element in browser.driver.find_elements("css selector", "input, select, textarea"):
                label = browser.driver.execute_script(
                    "const e=arguments[0]; const id=e.id; const l=id?document.querySelector('label[for=\"'+CSS.escape(id)+'\"]'):null; return l?.innerText || e.closest('mat-form-field, .formly-field, .form-group')?.innerText || '';",
                    element,
                )
                print(
                    "FRAME_FIELD",
                    element.tag_name,
                    element.get_attribute("type"),
                    "id=", element.get_attribute("id"),
                    "name=", element.get_attribute("name"),
                    "required=", element.get_attribute("required"),
                    "role=", element.get_attribute("role"),
                    "aria_controls=", element.get_attribute("aria-controls"),
                    "label=", repr(label[:250]),
                )
            for combo_id in ("salutation", "formly_9_select_gewobag_fuer_wen_wird_die_wohnungsanfrage_gestellt_0"):
                combo = browser.driver.find_element("id", combo_id)
                combo.click()
                time.sleep(0.5)
                options = browser.driver.find_elements("css selector", "[role=option], mat-option, .mat-mdc-option")
                print("OPTIONS", combo_id, [item.text for item in options if item.is_displayed()])
                visible = [item for item in options if item.is_displayed()]
                if combo_id == "salutation":
                    choice = next((item for item in visible if "herr" in item.text.casefold()), None)
                else:
                    choice = next((item for item in visible if "selbst" in item.text.casefold()), None)
                if choice:
                    print("CHOOSE", combo_id, choice.text)
                    choice.click()
                    time.sleep(0.5)
            wbs_yes = browser.driver.find_elements("css selector", "input[id*='wbs_available'][id$='-Ja']")
            if wbs_yes:
                wbs_yes[0].click()
                time.sleep(0.5)
                date_field = browser.driver.find_element("css selector", "input[id*='wbs_valid_until']")
                print("WBS_DATE", date_field.get_attribute("placeholder"), date_field.get_attribute("value"))
                date_field.send_keys("01.04.2027")
                print("WBS_DATE_AFTER", date_field.get_attribute("value"))
                combos = [
                    ("input[id*='gewobag_art_bezeichnung_des_wbs']", "WBS 100"),
                    ("input[id*='wbs_max_number_rooms']", "2"),
                ]
                for selector, desired in combos:
                    combo = browser.driver.find_element("css selector", selector)
                    combo.click()
                    time.sleep(0.5)
                    options = browser.driver.find_elements("css selector", "[role=option], mat-option, .mat-mdc-option")
                    visible_options = [item for item in options if item.is_displayed()]
                    print("WBS_OPTIONS", selector, [item.text for item in visible_options])
                    choice = next((item for item in visible_options if item.text.strip() == desired), None)
                    if choice:
                        choice.click()
                        time.sleep(0.5)
            fill_values = {
                "firstName": "Test",
                "lastName": "Person",
                "email": "test@example.com",
                "phone-number": "015123456789",
                "street": "Teststrasse",
                "house-number": "1",
                "zip-code": "10115",
                "city": "Berlin",
                "formly_2_input_gewobag_gesamtzahl_der_einziehenden_personen_erwachsene_und_kinder_0": "1",
                "formly_17_input_$$_telephone_number_$$_0": "015123456789",
            }
            for field_id, value in fill_values.items():
                field = browser.driver.find_element("id", field_id)
                field.clear()
                field.send_keys(value)
            privacy = browser.driver.find_element("css selector", "input[id*='gewobag_datenschutzhinweis_bestaetigt']")
            if not privacy.is_selected():
                privacy.click()
            time.sleep(1)
            send_button = next(
                element
                for element in browser.driver.find_elements("css selector", "button")
                if "anfrage versenden" in element.text.casefold()
            )
            print("SEND_STATE", send_button.is_enabled(), send_button.get_attribute("disabled"), send_button.get_attribute("class"))
            print("VALIDATION_TEXT", [
                item.text
                for item in browser.driver.find_elements("css selector", ".ng-invalid, .invalid-feedback, mat-error, .error")
                if item.is_displayed() and item.text.strip()
            ])
            print("FILE_VISIBLE", [
                (item.is_displayed(), item.get_attribute("accept"))
                for item in browser.driver.find_elements("css selector", "input[type=file]")
            ])
            print("VISIBLE_AFTER_SELECTION", [
                (element.get_attribute("id"), element.is_displayed())
                for element in browser.driver.find_elements("css selector", "input, select, textarea")
            ])
            for element in browser.driver.find_elements("css selector", "button, a, input[type=submit], [role=button]"):
                text = " ".join(filter(None, [element.text, element.get_attribute("aria-label"), element.get_attribute("value")]))
                if text.strip():
                    print("FRAME_CONTROL", element.tag_name, repr(text), element.get_attribute("id"), element.get_attribute("href"))
            browser.driver.switch_to.default_content()
        for element in browser.driver.find_elements("css selector", "input, select, textarea"):
            print(
                "FIELD",
                element.tag_name,
                element.get_attribute("type"),
                "id=", element.get_attribute("id"),
                "name=", element.get_attribute("name"),
                "placeholder=", element.get_attribute("placeholder"),
                "aria=", element.get_attribute("aria-label"),
            )
        for element in browser.driver.find_elements("css selector", "button, a, input[type=submit], [role=button]"):
            text = " ".join(filter(None, [element.text, element.get_attribute("aria-label"), element.get_attribute("value")]))
            if text.strip():
                print("CONTROL", element.tag_name, repr(text), element.get_attribute("href"))
    finally:
        browser.quit()
