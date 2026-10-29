"""Local-only Ollama adapter for story generation."""

from __future__ import annotations

import json
import http.client
import re
import socket
import threading
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from typing import Any


_BASE_URL = "http://127.0.0.1:11434"
_MODEL_NAME = re.compile(r"^[A-Za-z0-9._:/-]{1,200}$")


def _close_response(response: Any) -> None:
    response_socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
    if response_socket is not None:
        try:
            response_socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    try:
        response.close()
    except OSError:
        pass


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

    def generate(self, model: str, messages: list[dict[str, str]], *, cancel_event: threading.Event | None = None) -> str:
        return self._generate(model, messages, num_predict=1200, cancel_event=cancel_event)

    def generate_json(self, model: str, messages: list[dict[str, str]], *, cancel_event: threading.Event | None = None) -> dict[str, Any]:
        content = self._generate(model, messages, output_format="json", num_predict=4000, cancel_event=cancel_event)
        try:
            value = json.loads(content)
        except json.JSONDecodeError as error:
            raise OllamaError("Ollama did not return valid JSON.") from error
        if not isinstance(value, dict):
            raise OllamaError("Ollama returned an invalid structured response.")
        return value

    def _generate(
        self,
        model: str,
        messages: list[dict[str, str]],
        *,
        output_format: str | None = None,
        num_predict: int,
        cancel_event: threading.Event | None = None,
    ) -> str:
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
            raise OllamaError("The model request is invalid.")
        payload: dict[str, Any] = {
            "model": normalized_model,
            "messages": messages,
            "stream": False,
            "options": {"num_predict": num_predict},
        }
        if output_format:
            payload["format"] = output_format
        response = self._request("/api/chat", payload, cancel_event=cancel_event)
        message = response.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise OllamaError("Ollama returned an empty response.")
        return content.strip()

    def _request(
        self, path: str, payload: dict[str, Any] | None = None,
        *, cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            f"{_BASE_URL}{path}",
            data=body,
            headers={"Content-Type": "application/json"} if body is not None else {},
            method="POST" if body is not None else "GET",
        )
        if cancel_event and cancel_event.is_set():
            raise OllamaError("Ollama generation was stopped.")
        response_ready = threading.Event()
        request_complete = threading.Event()
        response_lock = threading.Lock()
        response_contexts = []

        def close_response_on_cancel() -> None:
            while not request_complete.wait(0.05):
                if cancel_event and cancel_event.is_set():
                    response_ready.wait(self.timeout_seconds)
                    with response_lock:
                        response = response_contexts[0] if response_contexts else None
                    if response is not None:
                        _close_response(response)
                    return

        watcher = threading.Thread(target=close_response_on_cancel, daemon=True) if cancel_event else None
        if watcher:
            watcher.start()
        try:
            response_context = urlopen(request, timeout=self.timeout_seconds)
            with response_lock:
                response_contexts.append(response_context)
                response_ready.set()
            if cancel_event and cancel_event.is_set():
                response_context.close()
                raise OllamaError("Ollama generation was stopped.")
            with response_context as response:
                parsed = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            if cancel_event and cancel_event.is_set():
                raise OllamaError("Ollama generation was stopped.") from error
            detail = error.read(1000).decode("utf-8", errors="replace").strip()
            raise OllamaError(detail or f"Ollama returned HTTP {error.code}.") from error
        except TimeoutError as error:
            if cancel_event and cancel_event.is_set():
                raise OllamaError("Ollama generation was stopped.") from error
            raise OllamaError("Ollama request timed out.") from error
        except URLError as error:
            if cancel_event and cancel_event.is_set():
                raise OllamaError("Ollama generation was stopped.") from error
            if isinstance(error.reason, TimeoutError):
                raise OllamaError("Ollama request timed out.") from error
            raise OllamaError("Ollama is not responding on this device.") from error
        except (OSError, http.client.HTTPException) as error:
            if cancel_event and cancel_event.is_set():
                raise OllamaError("Ollama generation was stopped.") from error
            raise OllamaError("Ollama is not responding on this device.") from error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise OllamaError("Ollama returned invalid JSON.") from error
        except ValueError as error:
            if cancel_event and cancel_event.is_set():
                raise OllamaError("Ollama generation was stopped.") from error
            raise OllamaError("Ollama returned an invalid response.") from error
        finally:
            response_ready.set()
            request_complete.set()
            if watcher:
                watcher.join(timeout=0.1)
        if not isinstance(parsed, dict):
            raise OllamaError("Ollama returned an invalid response.")
        return parsed
