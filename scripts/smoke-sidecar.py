"""Verify the packaged API starts with isolated data and enforces its token."""

import json
from contextlib import closing
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


class SmokeDirectory(tempfile.TemporaryDirectory):
    def cleanup(self):
        deadline = time.monotonic() + 10
        while True:
            try:
                return super().cleanup()
            except PermissionError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.2)


def main():
    executable = Path(sys.argv[1]).resolve(strict=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    token = secrets.token_urlsafe(32)
    with SmokeDirectory(prefix="lke-smoke-") as data_dir:
        environment = {**os.environ, "LKE_API_PORT": str(port), "LKE_API_TOKEN": token, "LKE_DATA_DIR": data_dir}
        process = subprocess.Popen(
            [str(executable)], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            base = f"http://127.0.0.1:{port}/api/v1"
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    raise RuntimeError("Bundled API exited before becoming healthy")
                try:
                    with urllib.request.urlopen(base + "/health", timeout=1) as response:
                        assert response.status == 200
                    break
                except (OSError, urllib.error.URLError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Bundled API did not become healthy within 30 seconds")
                    time.sleep(0.2)
            try:
                urllib.request.urlopen(base + "/workspaces", timeout=5)
            except urllib.error.HTTPError as error:
                assert error.code == 401, f"Expected 401, received {error.code}"
            else:
                raise AssertionError("Data route accepted a request without a token")
            request = urllib.request.Request(base + "/workspaces", headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(request, timeout=5) as response:
                assert response.status == 200
                assert json.load(response) == [], "Smoke database was not isolated"
            def post(path, payload):
                request = urllib.request.Request(
                    base + path, data=json.dumps(payload).encode("utf-8"),
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    return json.load(response)

            post("/workspaces", {"workspace_id": "smoke-workspace", "name": "Smoke workspace"})
            result = post("/workspaces/smoke-workspace/commands", {
                "branch_id": "main", "expected_revision": 0, "idempotency_key": "smoke-entity",
                "command_type": "create_entity", "reason": "Verify packaged persistence",
                "payload": {"entity_id": "smoke-character", "entity_type": "character", "label": "شخصیت آزمایشی"},
            })
            assert result["revision"] == 1
        finally:
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                else:
                    process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        with closing(sqlite3.connect(Path(data_dir) / "knowledge.sqlite3")) as database:
            assert database.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert database.execute(
                "SELECT label FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                ("smoke-workspace", "main", "smoke-character"),
            ).fetchone()[0] == "شخصیت آزمایشی"
            assert database.execute(
                "SELECT COUNT(*) FROM audit_events WHERE workspace_id=?", ("smoke-workspace",)
            ).fetchone()[0] >= 1
        print("Bundled API health, authentication, command persistence, Unicode, and audit checks passed.")


if __name__ == "__main__":
    main()
