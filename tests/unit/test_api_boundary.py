"""Authenticated local API behavior using an in-memory database."""

from __future__ import annotations

import asyncio
import os
import unittest
from unittest.mock import patch

import httpx

from lke.api.app import create_app
from lke.core import Database


class ApiBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = Database(":memory:")
        self.app = create_app(self.database, auth_token="test-token")
        self.headers = {"Authorization": "Bearer test-token"}

    def tearDown(self) -> None:
        self.database.close()

    def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        async def send() -> httpx.Response:
            transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 8000))
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.request(method, path, **kwargs)

        return asyncio.run(send())

    def test_health_is_public_but_data_requires_authentication(self) -> None:
        self.assertEqual(self.request("GET", "/api/v1/health").status_code, 200)
        self.assertEqual(self.request("GET", "/api/v1/workspaces").status_code, 401)

    def test_unknown_origin_is_rejected(self) -> None:
        response = self.request(
            "GET",
            "/api/v1/workspaces",
            headers={**self.headers, "Origin": "https://untrusted.example"},
        )
        self.assertEqual(response.status_code, 403)

    def test_preflight_allows_only_required_methods_and_headers(self) -> None:
        origin = "http://127.0.0.1:5173"
        with patch.dict(os.environ, {"LKE_DEV_MODE": "1"}):
            self.app = create_app(self.database, auth_token="test-token")
            allowed = self.request(
                "OPTIONS",
                "/api/v1/workspaces",
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "authorization, content-type",
                },
            )
            denied = self.request(
                "OPTIONS",
                "/api/v1/workspaces",
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "DELETE",
                    "Access-Control-Request-Headers": "authorization, content-type",
                },
            )
        self.assertEqual(allowed.status_code, 204)
        self.assertEqual(denied.status_code, 403)

    def test_authenticated_command_round_trip(self) -> None:
        created = self.request(
            "POST",
            "/api/v1/workspaces",
            headers=self.headers,
            json={"workspace_id": "api-workspace", "name": "API Test"},
        )
        self.assertEqual(created.status_code, 201)
        response = self.request(
            "POST",
            "/api/v1/workspaces/api-workspace/commands",
            headers=self.headers,
            json={
                "branch_id": "main",
                "expected_revision": 0,
                "idempotency_key": "create-api-entity",
                "command_type": "create_entity",
                "reason": "Exercise the authenticated API",
                "payload": {
                    "entity_id": "api-entity",
                    "entity_type": "concept",
                    "label": "API Entity",
                    "properties": {},
                },
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        entities = self.request(
            "GET", "/api/v1/workspaces/api-workspace/entities", headers=self.headers
        )
        self.assertEqual([item["entity_id"] for item in entities.json()], ["api-entity"])


if __name__ == "__main__":
    unittest.main()
