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
        url_patterns=["127.0.0.1"],
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
