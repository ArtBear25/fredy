"""Runtime paths and local-only defaults."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _default_data_dir() -> Path:
    if configured := os.getenv("BEWERBUNGSMODUL_DATA_DIR"):
        return Path(configured).expanduser().resolve()
    local_app_data = os.getenv("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "Wohnungsbot" / "Bewerbungsmodul"
    return Path.home() / ".wohnungsbot" / "bewerbungsmodul"


@dataclass(frozen=True, slots=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = int(os.getenv("BEWERBUNGSMODUL_PORT", "8765"))
    data_dir: Path = _default_data_dir()
    mail_poll_seconds: int = 15
    worker_poll_seconds: float = 1.0

    @property
    def database_path(self) -> Path:
        return self.data_dir / "bewerbungen.sqlite3"

    @property
    def chrome_profile_dir(self) -> Path:
        return self.data_dir / "chrome-profile"

    @property
    def vault_dir(self) -> Path:
        return self.data_dir / "vault"

    @property
    def screenshots_dir(self) -> Path:
        return self.data_dir / "screenshots"

    @property
    def temp_dir(self) -> Path:
        return self.data_dir / "temp"

    def ensure_directories(self) -> None:
        for path in (
            self.data_dir,
            self.chrome_profile_dir,
            self.vault_dir,
            self.screenshots_dir,
            self.temp_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)


settings = Settings()
