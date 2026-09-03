"""Selenium browser lifecycle and deterministic locator resolution."""

from __future__ import annotations

import re
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

from selenium import webdriver
from selenium.common.exceptions import NoSuchElementException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
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


def domain_allowed(url: str, allowed_domains: list[str]) -> bool:
    hostname = (urlparse(url).hostname or "").casefold().strip(".")
    return any(hostname == domain or hostname.endswith(f".{domain}") for domain in allowed_domains)


class BrowserController:
    def __init__(self, profile_dir: Path, extension_dir: Path | None = None, *, headless: bool = False):
        self.profile_dir = profile_dir
        self.extension_dir = extension_dir
        self.headless = headless
        self._driver: WebDriver | None = None
        self._lock = threading.RLock()

    @property
    def driver(self) -> WebDriver:
        with self._lock:
            if self._driver is None:
                self._driver = self._start()
            return self._driver

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
            options.add_argument(f"--load-extension={self.extension_dir}")
        return webdriver.Chrome(options=options)

    def quit(self) -> None:
        with self._lock:
            if self._driver is not None:
                try:
                    self._driver.quit()
                finally:
                    self._driver = None

    @contextmanager
    def exclusive(self) -> Iterator[None]:
        with self._lock:
            yield

    def open(self, url: str) -> None:
        self.driver.get(url)

    def screenshot(self, target: Path) -> str:
        target.parent.mkdir(parents=True, exist_ok=True)
        self.driver.save_screenshot(str(target))
        return str(target)

    def has_manual_challenge(self) -> bool:
        source = self.driver.page_source.casefold()
        return any(marker in source for marker in MANUAL_PAGE_MARKERS)

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

    def find(self, target: ElementTarget, timeout_seconds: int = 15) -> WebElement:
        candidates = sorted(target.candidates, key=lambda item: item.score, reverse=True)
        deadline = time.monotonic() + timeout_seconds
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            for candidate in candidates:
                by, value = _selenium_locator(candidate, target)
                elements = self.driver.find_elements(by, value)
                visible = [element for element in elements if element.is_displayed()]
                matches = visible or elements
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
        direct = f"//label[normalize-space()={literal}]//*[@id]"
        following = (
            f"//label[normalize-space()={literal}]/following::*"
            "[self::input or self::textarea or self::select][1]"
        )
        return (
            By.XPATH,
            f"{direct} | {following}",
        )
    if strategy == "role":
        role, _, name = value.partition("|")
        name_literal = _xpath_literal(name.strip())
        role_literal = _xpath_literal(role.strip())
        return (
            By.XPATH,
            f"//*[@role={role_literal} and (@aria-label={name_literal} or normalize-space()={name_literal})]",
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
