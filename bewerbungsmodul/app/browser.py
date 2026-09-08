"""Selenium browser lifecycle and deterministic locator resolution."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

from selenium import webdriver
from selenium.common.exceptions import NoSuchElementException, TimeoutException, WebDriverException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.selenium_manager import SeleniumManager
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.remote.webelement import WebElement

from app.models import ElementTarget, LocatorCandidate

MANUAL_PAGE_MARKERS = (
    "captcha",
    "ich bin kein roboter",
    "verify you are human",
    "sicherheitscode",
    "two-factor",
    "2-factor",
)


class AmbiguousTargetError(RuntimeError):
    """An existing selector identifies multiple elements; fallback would be guessing."""


def domain_allowed(url: str, allowed_domains: list[str]) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        return False
    hostname = (parsed.hostname or "").casefold().strip(".")
    return any(hostname == domain or hostname.endswith(f".{domain}") for domain in allowed_domains)


class BrowserController:
    def __init__(
        self,
        profile_dir: Path,
        extension_dir: Path | None = None,
        *,
        headless: bool = False,
        recorder_token: str = "",
        recorder_endpoint: str = "http://127.0.0.1:8765",
    ):
        self.profile_dir = profile_dir
        self.extension_dir = extension_dir
        self.headless = headless
        self._driver: WebDriver | None = None
        self._lock = threading.RLock()
        self._workflow_tabs: list[str] = []
        self.recorder_token = recorder_token
        self.recorder_endpoint = recorder_endpoint

    def _runtime(self) -> dict:
        """Install Google's Chrome for Testing once; reuse that exact browser/driver pair."""
        manifest = self.profile_dir.parent / "browser-runtime.json"
        cache = self.profile_dir.parent / "browser-cache"
        if manifest.is_file():
            cached = json.loads(manifest.read_text(encoding="utf-8"))
            if all(Path(cached[key]).is_file() for key in ("browser_path", "driver_path")) and Path(
                cached["browser_path"]
            ).resolve().is_relative_to(cache.resolve()):
                return cached
        paths = SeleniumManager().binary_paths(
            [
                "--browser",
                "chrome",
                "--browser-version",
                "stable",
                "--skip-browser-in-path",
                "--force-browser-download",
                "--skip-driver-in-path",
                "--cache-path",
                str(cache),
                "--avoid-stats",
            ]
        )
        manifest.write_text(json.dumps(paths), encoding="utf-8")
        return paths

    @property
    def driver(self) -> WebDriver:
        with self._lock:
            if self._driver is not None:
                try:
                    _ = self._driver.current_window_handle
                except WebDriverException:
                    self._discard_driver()
            if self._driver is None:
                self._driver = self._start()
            return self._driver

    def _discard_driver(self) -> None:
        driver = self._driver
        self._driver = None
        self._workflow_tabs = []
        if driver is not None:
            try:
                driver.quit()
            except WebDriverException:
                pass

    def _start(self) -> WebDriver:
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        options = Options()
        options.add_argument(f"--user-data-dir={self.profile_dir}")
        options.add_argument("--profile-directory=Bewerbungsmodul")
        options.add_argument("--start-maximized")
        options.add_argument("--disable-features=PasswordLeakDetection")
        if self.headless:
            options.add_argument("--headless=new")
            options.add_argument("--disable-gpu")
        options.set_capability("goog:loggingPrefs", {"browser": "ALL"})
        if self.extension_dir and self.extension_dir.exists():
            token_id = hashlib.sha256(self.recorder_token.encode()).hexdigest()[:12]
            runtime_extension = self.profile_dir.parent / f"recorder-extension-{token_id}"
            shutil.copytree(self.extension_dir, runtime_extension, dirs_exist_ok=True)
            (runtime_extension / "settings.js").write_text(
                "const RECORDER_CONFIG = "
                + json.dumps({"token": self.recorder_token, "endpoint": self.recorder_endpoint})
                + ";",
                encoding="utf-8",
            )
            options.add_argument(f"--disable-extensions-except={runtime_extension}")
            options.add_argument(f"--load-extension={runtime_extension}")
        runtime = self._runtime()
        options.binary_location = runtime["browser_path"]
        driver = webdriver.Chrome(service=Service(runtime["driver_path"]), options=options)
        driver.set_page_load_timeout(30)
        return driver

    def quit(self) -> None:
        with self._lock:
            self._discard_driver()

    def ensure_available(self) -> None:
        """Ensure a usable Selenium session exists, restarting a stale one when necessary."""
        try:
            _ = self.driver
        except WebDriverException as error:
            raise ValueError("Chrome konnte für die Workflow-Aufnahme nicht gestartet werden") from error

    @contextmanager
    def exclusive(self) -> Iterator[None]:
        with self._lock:
            yield

    def open(self, url: str) -> None:
        if not self._workflow_tabs:
            self._workflow_tabs = [self.driver.current_window_handle]
        self.driver.get(url)

    def reset_tabs(self) -> None:
        driver = self.driver
        old_handles = driver.window_handles
        driver.switch_to.new_window("tab")
        fresh = driver.current_window_handle
        for handle in old_handles:
            driver.switch_to.window(handle)
            driver.close()
        driver.switch_to.window(fresh)
        self._workflow_tabs = [fresh]

    def switch_tab(self, index: int | None, timeout: int) -> None:
        """Wait for a recorded tab; never guess when several new windows appear together."""
        driver = self.driver
        if not self._workflow_tabs:
            self._workflow_tabs = [driver.current_window_handle]
        desired = len(self._workflow_tabs) if index is None else index
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            handles = driver.window_handles
            new = [handle for handle in handles if handle not in self._workflow_tabs]
            if len(new) > 1:
                raise AmbiguousTargetError("Mehrere neue Tabs sind nicht eindeutig zuzuordnen")
            self._workflow_tabs.extend(new)
            if 0 <= desired < len(self._workflow_tabs):
                handle = self._workflow_tabs[desired]
                if handle not in handles:
                    raise ValueError("Der aufgezeichnete Tab wurde geschlossen")
                driver.switch_to.window(handle)
                return
            time.sleep(0.05)
        raise TimeoutException("Der aufgezeichnete Tab wurde nicht geöffnet")

    def screenshot(self, target: Path) -> str:
        target.parent.mkdir(parents=True, exist_ok=True)
        self.driver.save_screenshot(str(target))
        return str(target)

    def state(self) -> dict:
        driver = self.driver
        return {
            "session": driver.session_id,
            "tab": driver.current_window_handle,
            "url": driver.current_url,
            "frame_url": driver.execute_script("return location.href"),
        }

    def has_manual_challenge(self) -> bool:
        bodies = self.driver.find_elements(By.TAG_NAME, "body")
        text = bodies[0].text.casefold() if bodies else ""
        visible_challenges = self.driver.find_elements(
            By.CSS_SELECTOR,
            (
                'iframe[src*="recaptcha"][title*="challenge"], '
                'iframe[src*="hcaptcha"], input[autocomplete="one-time-code"]'
            ),
        )
        return any(marker in text for marker in MANUAL_PAGE_MARKERS) or any(
            element.is_displayed() for element in visible_challenges
        )

    def has_blocked_action_page(self) -> bool:
        current = self.driver.current_url.casefold()
        blocked_paths = (
            "mietvertrag",
            "contract",
            "checkout",
            "payment",
            "zahlung",
            "kuendigung",
            "kündigung",
            "signature",
        )
        if any(marker in current for marker in blocked_paths):
            return True
        elements = self.driver.find_elements(By.CSS_SELECTOR, "button, a, input[type=submit], [role=button]")
        for element in elements:
            if not element.is_displayed():
                continue
            text = " ".join(
                filter(
                    None,
                    [
                        element.text,
                        element.get_attribute("aria-label"),
                        element.get_attribute("value"),
                        element.get_attribute("href"),
                        element.get_attribute("formaction"),
                    ],
                )
            )
            if looks_legally_binding(text):
                return True
        return False

    def find(
        self, target: ElementTarget, timeout_seconds: int = 15, *, allow_hidden: bool = False
    ) -> WebElement:
        candidates = sorted(target.candidates, key=lambda item: item.score, reverse=True)
        deadline = time.monotonic() + timeout_seconds
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            for candidate in candidates:
                by, value = _selenium_locator(candidate, target)
                elements = self.driver.find_elements(by, value)
                visible = [element for element in elements if element.is_displayed()]
                matches = elements if allow_hidden else visible
                if len(matches) > 1:
                    raise AmbiguousTargetError(f"Elementkennung ist mehrdeutig — {candidate.strategy}")
                if len(matches) == 1:
                    return matches[0]
                last_error = NoSuchElementException(
                    f"Locator {candidate.strategy} matched {len(matches)} elements"
                )
            time.sleep(0.2)
        raise NoSuchElementException(
            f"No unambiguous locator matched target {target.model_dump()}"
        ) from last_error


def _selenium_locator(candidate: LocatorCandidate, target: ElementTarget) -> tuple[str, str]:
    strategy = candidate.strategy
    value = candidate.value
    if strategy == "id":
        return By.ID, value
    if strategy == "name":
        return By.NAME, value
    if strategy == "css":
        return By.CSS_SELECTOR, value
    if strategy == "xpath":
        return By.XPATH, value
    if strategy == "testid":
        attribute, separator, raw_value = value.partition("=")
        if separator and attribute in {"data-testid", "data-test", "data-qa", "data-cy"}:
            escaped = raw_value.replace('"', '\\"')
            return By.CSS_SELECTOR, f'[{attribute}="{escaped}"]'
        escaped = value.replace('"', '\\"')
        return By.CSS_SELECTOR, (
            f'[data-testid="{escaped}"], [data-test="{escaped}"], '
            f'[data-qa="{escaped}"], [data-cy="{escaped}"]'
        )
    if strategy == "label":
        literal = _xpath_literal(value)
        direct = f"//*[@id=//label[normalize-space()={literal}]/@for]"
        following = f"//label[normalize-space()={literal}]//*[self::input or self::textarea or self::select]"
        return (
            By.XPATH,
            f"{direct} | {following}",
        )
    if strategy == "role":
        role, _, name = value.partition("|")
        name_literal = _xpath_literal(name.strip())
        role_literal = _xpath_literal(role.strip())
        implicit = {
            "button": "self::button or (self::input and (@type='button' or @type='submit'))",
            "link": "self::a[@href]",
        }.get(role.strip(), "false()")
        return (
            By.XPATH,
            f"//*[(@role={role_literal} or {implicit}) and "
            f"(@aria-label={name_literal} or @value={name_literal} "
            f"or normalize-space()={name_literal})]",
        )
    raise ValueError(f"Unsupported locator strategy {strategy}")


def _xpath_literal(value: str) -> str:
    if '"' not in value:
        return f'"{value}"'
    if "'" not in value:
        return f"'{value}'"
    parts = value.split('"')
    return "concat(" + ", '\"', ".join(f'"{part}"' for part in parts) + ")"


def looks_legally_binding(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", text).casefold()
    blocked = (
        "mietvertrag unterschreiben",
        "vertrag annehmen",
        "zahlungspflichtig",
        "kostenpflichtig bestellen",
        "jetzt bezahlen",
        "kündigung absenden",
        "digitale unterschrift",
        "vertrag jetzt abschließen",
        "vertrag jetzt abschliessen",
        "zahlung ausführen",
        "zahlung ausfuehren",
        "kündigung bestätigen",
        "kuendigung bestaetigen",
    )
    return any(marker in normalized for marker in blocked)
