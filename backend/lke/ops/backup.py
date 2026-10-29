"""Integrity-checked SQLite workspace backups and offline restores."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lke.core.database import Database, SCHEMA_VERSION


_FORMAT_VERSION = 1
_DATABASE_NAME = "knowledge.sqlite3"
_MANIFEST_NAME = "manifest.json"
_MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024
_MAX_MANIFEST_BYTES = 32 * 1024
MAX_BACKUP_ARCHIVE_BYTES = _MAX_DATABASE_BYTES + _MAX_MANIFEST_BYTES + 64 * 1024 * 1024
_REQUIRED_TABLES = {"schema_migrations", "workspaces", "branches", "revisions", "audit_events"}


class BackupError(ValueError):
    """Raised when a backup is malformed, unsupported, or unsafe to restore."""


def create_backup(database: Database, destination: str | Path) -> dict[str, Any]:
    """Write a consistent point-in-time backup without exposing SQLite WAL files."""
    target = Path(destination).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FileExistsError(f"Backup destination already exists: {target}")

    partial_path: Path | None = None
    with tempfile.TemporaryDirectory(prefix="lke-backup-") as temporary:
        snapshot_path = Path(temporary) / _DATABASE_NAME
        snapshot = sqlite3.connect(snapshot_path)
        try:
            with database.lock:
                database.connection.backup(snapshot)
            snapshot.commit()
            check = snapshot.execute("PRAGMA integrity_check").fetchone()[0]
            if check != "ok":
                raise BackupError(f"SQLite integrity check failed: {check}")
            row = snapshot.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
            schema_version = int(row[0] or 0)
            if schema_version != SCHEMA_VERSION:
                raise BackupError(f"Unsupported database schema version: {schema_version}")
        finally:
            snapshot.close()

        database_size = snapshot_path.stat().st_size
        if database_size > _MAX_DATABASE_BYTES:
            raise BackupError("Workspace database exceeds the backup size limit")
        digest = _sha256_file(snapshot_path)
        manifest = {
            "format": "lke.backup.v1",
            "format_version": _FORMAT_VERSION,
            "schema_version": schema_version,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "database_file": _DATABASE_NAME,
            "database_size": database_size,
            "database_sha256": digest,
        }

        handle, partial = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".partial", dir=target.parent)
        os.close(handle)
        partial_path = Path(partial)
        try:
            with zipfile.ZipFile(partial_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                archive.writestr(_MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2))
                archive.write(snapshot_path, _DATABASE_NAME)
            with partial_path.open("rb+") as backup_file:
                backup_file.flush()
                os.fsync(backup_file.fileno())
            if target.exists():
                raise FileExistsError(f"Backup destination already exists: {target}")
            os.replace(partial_path, target)
        except BaseException:
            partial_path.unlink(missing_ok=True)
            raise
    return manifest


def restore_backup(
    backup_path: str | Path,
    destination: str | Path,
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Validate a backup completely, then atomically install its SQLite snapshot."""
    source = Path(backup_path).expanduser().resolve()
    target = Path(destination).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if source == target:
        raise BackupError("Backup archive and restored database must be different files")
    if target.exists() and not overwrite:
        raise FileExistsError(f"Restore destination already exists: {target}; pass overwrite=True deliberately")
    target.parent.mkdir(parents=True, exist_ok=True)

    partial_path: Path | None = None
    try:
        with zipfile.ZipFile(source, "r") as archive:
            infos = archive.infolist()
            names = [item.filename for item in infos]
            if len(names) != 2 or set(names) != {_MANIFEST_NAME, _DATABASE_NAME}:
                raise BackupError("Backup must contain exactly a manifest and the workspace database")
            if len(set(names)) != len(names):
                raise BackupError("Backup contains duplicate archive entries")
            manifest_info = archive.getinfo(_MANIFEST_NAME)
            database_info = archive.getinfo(_DATABASE_NAME)
            if manifest_info.file_size > _MAX_MANIFEST_BYTES:
                raise BackupError("Backup manifest is too large")
            if database_info.file_size > _MAX_DATABASE_BYTES:
                raise BackupError("Workspace database exceeds the restore size limit")
            if archive.testzip() is not None:
                raise BackupError("Backup archive failed its CRC check")
            try:
                manifest = json.loads(archive.read(_MANIFEST_NAME))
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise BackupError("Backup manifest is not valid JSON") from error
            _validate_manifest(manifest, database_info.file_size)

            handle, partial = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".restore", dir=target.parent)
            os.close(handle)
            partial_path = Path(partial)
            digest = hashlib.sha256()
            written = 0
            with archive.open(_DATABASE_NAME, "r") as input_file, partial_path.open("wb") as output_file:
                while chunk := input_file.read(1024 * 1024):
                    written += len(chunk)
                    if written > _MAX_DATABASE_BYTES:
                        raise BackupError("Workspace database exceeds the restore size limit")
                    digest.update(chunk)
                    output_file.write(chunk)
                output_file.flush()
                os.fsync(output_file.fileno())
            if written != manifest["database_size"] or digest.hexdigest() != manifest["database_sha256"]:
                raise BackupError("Workspace database does not match the manifest")
            _validate_sqlite(partial_path, manifest["schema_version"])
            if target.exists() and not overwrite:
                raise FileExistsError(f"Restore destination already exists: {target}")
            os.replace(partial_path, target)
            partial_path = None
            return manifest
    except zipfile.BadZipFile as error:
        raise BackupError("Backup is not a valid ZIP archive") from error
    finally:
        if partial_path is not None:
            partial_path.unlink(missing_ok=True)


def restore_backup_into_database(database: Database, backup_path: str | Path) -> dict[str, Any]:
    """Validate a backup, then replace the open database through SQLite's backup API."""
    with database.lock:
        with tempfile.TemporaryDirectory(prefix="lke-active-restore-") as temporary:
            restored_path = Path(temporary) / _DATABASE_NAME
            manifest = restore_backup(backup_path, restored_path)
            restored = Database(restored_path)
            try:
                restored.connection.backup(database.connection)
                integrity = database.connection.execute("PRAGMA integrity_check").fetchone()[0]
                if integrity != "ok":
                    raise BackupError(f"Restored database integrity check failed: {integrity}")
                if database.connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise BackupError("Restored database contains invalid foreign-key references")
            finally:
                restored.close()
    return manifest


def _validate_manifest(manifest: Any, archive_database_size: int) -> None:
    if not isinstance(manifest, dict):
        raise BackupError("Backup manifest must be an object")
    if manifest.get("format") != "lke.backup.v1" or manifest.get("format_version") != _FORMAT_VERSION:
        raise BackupError("Unsupported backup format")
    if manifest.get("database_file") != _DATABASE_NAME:
        raise BackupError("Backup manifest names an unsupported database file")
    version = manifest.get("schema_version")
    if not isinstance(version, int) or version != SCHEMA_VERSION:
        raise BackupError(f"Unsupported database schema version: {version}")
    size = manifest.get("database_size")
    if not isinstance(size, int) or size != archive_database_size or size < 1:
        raise BackupError("Backup database size does not match its manifest")
    digest = manifest.get("database_sha256")
    if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise BackupError("Backup manifest has an invalid database digest")
    created_at = manifest.get("created_at")
    if not isinstance(created_at, str) or not created_at:
        raise BackupError("Backup manifest has no creation timestamp")


def _validate_sqlite(path: Path, manifest_schema_version: int) -> None:
    try:
        connection = sqlite3.connect(path)
        try:
            result = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if result != "ok":
                raise BackupError(f"Restored database integrity check failed: {result}")
            if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise BackupError("Restored database contains invalid foreign-key references")
            tables = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            }
            if not _REQUIRED_TABLES <= tables:
                raise BackupError("Restored database is missing required Lorethra tables")
            row = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
            schema_version = int(row[0] or 0)
            if schema_version != manifest_schema_version:
                raise BackupError("Database schema version does not match the backup manifest")
        finally:
            connection.close()
    except sqlite3.DatabaseError as error:
        raise BackupError("Backup does not contain a readable SQLite database") from error


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Create or restore a Lorethra workspace backup")
    commands = parser.add_subparsers(dest="operation", required=True)
    create = commands.add_parser("create", help="create a manifest-checked backup")
    create.add_argument("database", type=Path)
    create.add_argument("backup", type=Path)
    restore = commands.add_parser("restore", help="restore a validated backup into a database file")
    restore.add_argument("backup", type=Path)
    restore.add_argument("database", type=Path)
    restore.add_argument("--overwrite", action="store_true", help="replace an existing destination file")
    args = parser.parse_args()

    if args.operation == "create":
        database = Database(args.database)
        try:
            manifest = create_backup(database, args.backup)
        finally:
            database.close()
    else:
        manifest = restore_backup(args.backup, args.database, overwrite=args.overwrite)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
