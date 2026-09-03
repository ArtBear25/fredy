"""Windows-backed secrets and an encrypted local document vault."""

from __future__ import annotations

import hashlib
import os
import secrets
import tempfile
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime
from pathlib import Path
from typing import BinaryIO

import keyring
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.database import Database

SERVICE_NAME = "Wohnungsbot Bewerbungsmodul"


class SecretStore:
    def __init__(self, service_name: str = SERVICE_NAME):
        self.service_name = service_name

    def get(self, key: str) -> str | None:
        environment_key = "BEWERBUNGSMODUL_" + key.upper().replace(".", "_")
        if environment_key in os.environ:
            return os.environ[environment_key]
        return keyring.get_password(self.service_name, key)

    def set(self, key: str, value: str) -> None:
        keyring.set_password(self.service_name, key, value)

    def delete(self, key: str) -> None:
        try:
            keyring.delete_password(self.service_name, key)
        except keyring.errors.PasswordDeleteError:
            pass

    def get_or_create(self, key: str, bytes_count: int = 32) -> str:
        value = self.get(key)
        if value:
            return value
        value = secrets.token_urlsafe(bytes_count)
        self.set(key, value)
        return value


class DocumentVault:
    def __init__(self, vault_dir: Path, temp_dir: Path, database: Database, secrets_store: SecretStore):
        self.vault_dir = vault_dir
        self.temp_dir = temp_dir
        self.database = database
        self.secrets = secrets_store
        self.vault_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    def _key(self) -> bytes:
        encoded = self.secrets.get("vault.key")
        if not encoded:
            key = AESGCM.generate_key(bit_length=256)
            encoded = key.hex()
            self.secrets.set("vault.key", encoded)
        return bytes.fromhex(encoded)

    def add(
        self,
        source: BinaryIO,
        display_name: str,
        document_type: str,
        expires_at: date | None = None,
    ) -> str:
        plaintext = source.read()
        if not plaintext:
            raise ValueError("Document is empty")
        document_id = uuid.uuid4().hex
        nonce = os.urandom(12)
        encrypted = nonce + AESGCM(self._key()).encrypt(nonce, plaintext, document_id.encode())
        encrypted_path = self.vault_dir / f"{document_id}.vault"
        encrypted_path.write_bytes(encrypted)
        metadata = {
            "id": document_id,
            "display_name": Path(display_name).name,
            "document_type": document_type.strip().lower(),
            "encrypted_path": str(encrypted_path),
            "sha256": hashlib.sha256(plaintext).hexdigest(),
            "expires_at": expires_at.isoformat() if expires_at else None,
            "created_at": datetime.now(UTC).isoformat(),
        }
        self.database.save_document_metadata(metadata)
        return document_id

    @contextmanager
    def materialize(self, document_id: str) -> Iterator[Path]:
        metadata = self.database.get_document_by_reference(document_id)
        if not metadata:
            raise FileNotFoundError(f"Unknown document {document_id}")
        document_id = metadata["id"]
        if metadata["expires_at"] and date.fromisoformat(metadata["expires_at"]) < date.today():
            raise ValueError("Document has expired")
        payload = Path(metadata["encrypted_path"]).read_bytes()
        nonce, ciphertext = payload[:12], payload[12:]
        plaintext = AESGCM(self._key()).decrypt(nonce, ciphertext, document_id.encode())
        suffix = Path(metadata["display_name"]).suffix
        handle, path_text = tempfile.mkstemp(prefix="wohnungsbot-", suffix=suffix, dir=self.temp_dir)
        os.close(handle)
        path = Path(path_text)
        try:
            path.write_bytes(plaintext)
            yield path
        finally:
            if path.exists():
                path.unlink()
