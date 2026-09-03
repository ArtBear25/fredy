from __future__ import annotations

from pathlib import Path

import pytest

from app.database import Database


class MemorySecrets:
    def __init__(self):
        self.values: dict[str, str] = {}

    def get(self, key: str):
        return self.values.get(key)

    def set(self, key: str, value: str):
        self.values[key] = value

    def delete(self, key: str):
        self.values.pop(key, None)

    def get_or_create(self, key: str, bytes_count: int = 32):
        return self.values.setdefault(key, "test-token")


@pytest.fixture
def database(tmp_path: Path):
    db = Database(tmp_path / "test.sqlite3")
    yield db
    db.close()


@pytest.fixture
def secrets():
    return MemorySecrets()
