"""Local-only Ollama adapter for story generation."""

from __future__ import annotations

import json
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from typing import Any


_BASE_URL = "http://127.0.0.1:11434"
_MODEL_NAME = re.compile(r"^[A-Za-z0-9._:/-]{1,200}$")


class OllamaError(RuntimeError):
    """A local Ollama service or response could not satisfy the request."""


class OllamaClient:
    """Calls the Ollama service on loopback only; no remote host is configurable."""

    def __init__(self, timeout_seconds: float = 300) -> None:
        self.timeout_seconds = timeout_seconds

    def list_models(self) -> list[str]:
        response = self._request("/api/tags")
        models = response.get("models")
        if not isinstance(models, list):
            raise OllamaError("Ollama returned an invalid model list.")
        names = sorted({item["name"] for item in models if isinstance(item, dict) and isinstance(item.get("name"), str)})
        return names

    def generate(self, model: str, messages: list[dict[str, str]]) -> str:
        normalized_model = model.strip() if isinstance(model, str) else ""
        if (
            not _MODEL_NAME.fullmatch(normalized_model)
            or normalized_model.lower().startswith(("http://", "https://"))
        ):
            raise OllamaError("Choose a valid local model name.")
        if not messages or any(
            not isinstance(message, dict)
            or message.get("role") not in {"system", "user", "assistant"}
            or not isinstance(message.get("content"), str)
            for message in messages
        ):
            raise OllamaError("The story context is invalid.")
        response = self._request(
            "/api/chat",
            {"model": normalized_model, "messages": messages, "stream": False, "options": {"num_predict": 1200}},
        )
        message = response.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise OllamaError("Ollama returned an empty story continuation.")
        return content.strip()

    def _request(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            f"{_BASE_URL}{path}",
            data=body,
            headers={"Content-Type": "application/json"} if body is not None else {},
            method="POST" if body is not None else "GET",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                parsed = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read(1000).decode("utf-8", errors="replace").strip()
            raise OllamaError(detail or f"Ollama returned HTTP {error.code}.") from error
        except (URLError, TimeoutError, OSError) as error:
            raise OllamaError("Ollama is not responding on this device.") from error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise OllamaError("Ollama returned invalid JSON.") from error
        if not isinstance(parsed, dict):
            raise OllamaError("Ollama returned an invalid response.")
        return parsed
