"""Optional story-generation providers with no provider-owned canonical storage."""

from __future__ import annotations

import ipaddress
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .ollama import OllamaClient, OllamaError


class StoryProviderError(RuntimeError):
    """A configured provider could not complete a story request safely."""


_PROVIDER_IDS = {"ollama", "openai", "claude", "codex", "huggingface", "huggingface_local"}
_MODEL_NAME = re.compile(r"^[A-Za-z0-9._:/-]{1,200}$")
_DEFAULT_LOCAL_HF_URL = "http://127.0.0.1:8000/v1"
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def _validated_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    if not messages or len(messages) > 100:
        raise StoryProviderError("The model request is invalid.")
    checked: list[dict[str, str]] = []
    for message in messages:
        if (
            not isinstance(message, dict)
            or message.get("role") not in {"system", "user", "assistant"}
            or not isinstance(message.get("content"), str)
            or len(message["content"]) > 50_000
        ):
            raise StoryProviderError("The model request is invalid.")
        checked.append({"role": message["role"], "content": message["content"]})
    return checked


def _validated_model(model: str) -> str:
    value = model.strip() if isinstance(model, str) else ""
    if not _MODEL_NAME.fullmatch(value) or value.lower().startswith(("http://", "https://")):
        raise StoryProviderError("Enter a valid model name.")
    return value


def _read_json_response(response: Any) -> dict[str, Any]:
    raw = response.read(_MAX_RESPONSE_BYTES + 1)
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise StoryProviderError("The provider response exceeded the size limit.")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise StoryProviderError("The provider returned invalid JSON.") from error
    if not isinstance(value, dict):
        raise StoryProviderError("The provider returned an invalid response.")
    return value


def _request_json(
    url: str,
    *,
    method: str = "POST",
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 300,
) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request_headers = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    request = Request(url, data=body, headers=request_headers, method=method)
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            return _read_json_response(response)
    except HTTPError as error:
        # Provider bodies can echo prompts or request details. Keep them out of errors and logs.
        raise StoryProviderError(f"The selected provider returned HTTP {error.code}.") from error
    except (URLError, TimeoutError, OSError) as error:
        raise StoryProviderError("The selected provider is not responding.") from error


def _text_from_openai_compatible(value: dict[str, Any]) -> str:
    choices = value.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        message = choices[0].get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str) and content.strip():
            return content.strip()
    raise StoryProviderError("The selected provider returned no story text.")


def _chat_completion(
    *, base_url: str, model: str, messages: list[dict[str, str]], api_key: str | None,
    timeout_seconds: float = 300,
) -> str:
    checked = _validated_messages(messages)
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    value = _request_json(
        f"{base_url.rstrip('/')}/chat/completions",
        payload={"model": _validated_model(model), "messages": checked, "stream": False, "max_tokens": 1200},
        headers=headers,
        timeout_seconds=timeout_seconds,
    )
    return _text_from_openai_compatible(value)


def _openai_responses(model: str, messages: list[dict[str, str]], api_key: str) -> str:
    checked = _validated_messages(messages)
    instructions = "\n\n".join(message["content"] for message in checked if message["role"] == "system")
    inputs = [
        {"role": message["role"], "content": message["content"]}
        for message in checked if message["role"] in {"user", "assistant"}
    ]
    value = _request_json(
        "https://api.openai.com/v1/responses",
        payload={"model": _validated_model(model), "instructions": instructions, "input": inputs,
                 "max_output_tokens": 1200},
        headers={"Authorization": f"Bearer {api_key}"},
    )
    output: list[str] = []
    for item in value.get("output", []):
        if isinstance(item, dict) and item.get("type") == "message":
            for block in item.get("content", []):
                if isinstance(block, dict) and block.get("type") == "output_text" and isinstance(block.get("text"), str):
                    output.append(block["text"])
    text = "\n".join(output).strip()
    if not text:
        raise StoryProviderError("OpenAI returned no story text.")
    return text


def _anthropic_messages(model: str, messages: list[dict[str, str]], api_key: str) -> str:
    checked = _validated_messages(messages)
    instructions = "\n\n".join(message["content"] for message in checked if message["role"] == "system")
    content = [message for message in checked if message["role"] in {"user", "assistant"}]
    value = _request_json(
        "https://api.anthropic.com/v1/messages",
        payload={"model": _validated_model(model), "max_tokens": 1200,
                 "system": instructions, "messages": content},
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
    )
    blocks = value.get("content")
    text = "\n".join(
        block["text"] for block in blocks
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    ).strip() if isinstance(blocks, list) else ""
    if not text:
        raise StoryProviderError("Claude returned no story text.")
    return text


def _local_hf_base_url(env: dict[str, str]) -> str:
    base_url = env.get("LKE_HF_LOCAL_BASE_URL", _DEFAULT_LOCAL_HF_URL).strip().rstrip("/")
    parsed = urlparse(base_url)
    try:
        loopback = parsed.hostname is not None and ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    if (
        parsed.scheme != "http" or not loopback or parsed.username or parsed.password
        or parsed.query or parsed.fragment or not parsed.path.startswith("/v1")
    ):
        raise StoryProviderError("The Hugging Face local endpoint must be an HTTP loopback /v1 URL.")
    return base_url


def _model_names(base_url: str, api_key: str | None = None) -> list[str]:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    value = _request_json(f"{base_url.rstrip('/')}/models", method="GET", headers=headers, timeout_seconds=3)
    items = value.get("data", value.get("models", []))
    if not isinstance(items, list):
        return []
    names = {
        item.get("id", item.get("name")) for item in items
        if isinstance(item, dict) and isinstance(item.get("id", item.get("name")), str)
    }
    return sorted(name for name in names if _MODEL_NAME.fullmatch(name))


class _CodexAppServer:
    """One ephemeral, read-only Codex app-server turn; story state stays in LKE."""

    def __init__(self, env: dict[str, str], timeout_seconds: float = 300) -> None:
        self.env = env
        self.timeout_seconds = timeout_seconds

    def generate(self, model: str, messages: list[dict[str, str]]) -> str:
        executable = self.env.get("LKE_CODEX_APP_SERVER_EXECUTABLE") or shutil.which("codex")
        if not executable:
            raise StoryProviderError("Codex app-server was not found. Install or configure the Codex CLI first.")
        checked = _validated_messages(messages)
        instructions = "\n\n".join(message["content"] for message in checked if message["role"] == "system")
        transcript = "\n\n".join(
            f"{message['role'].upper()}:\n{message['content']}"
            for message in checked if message["role"] in {"user", "assistant"}
        )
        child_env = dict(self.env)
        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HF_TOKEN", "HUGGINGFACEHUB_API_TOKEN"):
            child_env.pop(key, None)

        with tempfile.TemporaryDirectory(prefix="lke-codex-story-") as scratch:
            try:
                process = subprocess.Popen(
                    [executable, "app-server", "--listen", "stdio://"], cwd=scratch,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, encoding="utf-8", errors="replace", bufsize=1, env=child_env,
                )
            except OSError as error:
                raise StoryProviderError("Codex app-server could not be started.") from error
            messages_in: queue.Queue[str | None] = queue.Queue()

            def read_lines() -> None:
                try:
                    assert process.stdout is not None
                    for line in process.stdout:
                        messages_in.put(line)
                finally:
                    messages_in.put(None)

            reader = threading.Thread(target=read_lines, daemon=True)
            reader.start()

            def send(value: dict[str, Any]) -> None:
                if process.stdin is None:
                    raise StoryProviderError("Codex app-server closed its input stream.")
                process.stdin.write(json.dumps(value, ensure_ascii=False) + "\n")
                process.stdin.flush()

            def receive(deadline: float, response_id: int) -> dict[str, Any]:
                import time

                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise StoryProviderError("Codex app-server timed out.")
                    try:
                        line = messages_in.get(timeout=remaining)
                    except queue.Empty as error:
                        raise StoryProviderError("Codex app-server timed out.") from error
                    if line is None:
                        raise StoryProviderError("Codex app-server stopped before completing the turn.")
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    if event.get("id") == response_id:
                        if "error" in event:
                            raise StoryProviderError("Codex app-server rejected the request.")
                        result = event.get("result")
                        return result if isinstance(result, dict) else {}
                    if "id" in event and "method" in event:
                        # Never approve app-server requests for shell, file, or external tools.
                        send({"id": event["id"], "error": {"code": -32000, "message": "Story Studio does not approve tools."}})

            try:
                deadline = __import__("time").monotonic() + self.timeout_seconds
                send({"id": 1, "method": "initialize", "params": {
                    "clientInfo": {"name": "living_knowledge_engine", "title": "Story Studio", "version": "0.1.0"}
                }})
                receive(deadline, 1)
                send({"method": "initialized", "params": {}})
                params: dict[str, Any] = {
                    "cwd": scratch, "sandbox": "read-only", "approvalPolicy": "never",
                    "ephemeral": True, "baseInstructions": instructions,
                    "runtimeWorkspaceRoots": [],
                }
                if model.strip():
                    params["model"] = _validated_model(model)
                thread = receive_after_send(send, receive, deadline, "thread/start", 2, params)
                thread_id = thread.get("thread", {}).get("id") if isinstance(thread.get("thread"), dict) else None
                if not isinstance(thread_id, str):
                    raise StoryProviderError("Codex app-server did not create a story turn.")
                send({"id": 3, "method": "turn/start", "params": {
                    "threadId": thread_id, "input": [{"type": "text", "text": transcript}]
                }})
                chunks: list[str] = []
                while True:
                    remaining = deadline - __import__("time").monotonic()
                    if remaining <= 0:
                        raise StoryProviderError("Codex app-server timed out.")
                    try:
                        line = messages_in.get(timeout=remaining)
                    except queue.Empty as error:
                        raise StoryProviderError("Codex app-server timed out.") from error
                    if line is None:
                        raise StoryProviderError("Codex app-server stopped before completing the turn.")
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    if event.get("id") == 3:
                        if "error" in event:
                            raise StoryProviderError("Codex app-server rejected the turn.")
                        continue
                    if event.get("method") == "item/agentMessage/delta":
                        delta = event.get("params", {}).get("delta")
                        if isinstance(delta, str):
                            chunks.append(delta)
                    elif event.get("method") == "turn/completed":
                        turn = event.get("params", {}).get("turn", {})
                        if not isinstance(turn, dict) or turn.get("status") != "completed":
                            raise StoryProviderError("Codex app-server did not complete the turn.")
                        result = "".join(chunks).strip()
                        if not result:
                            raise StoryProviderError("Codex app-server returned no story text.")
                        return result
                    elif event.get("method") == "item/started":
                        item = event.get("params", {}).get("item", {})
                        if isinstance(item, dict) and item.get("type") in {"commandExecution", "fileChange", "mcpToolCall", "webSearch"}:
                            raise StoryProviderError("Codex app-server attempted a tool; this story provider allows text only.")
                    elif "id" in event and "method" in event:
                        send({"id": event["id"], "error": {"code": -32000, "message": "Story Studio does not approve tools."}})
            finally:
                if process.stdin is not None:
                    process.stdin.close()
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=2)


def receive_after_send(send: Any, receive: Any, deadline: float, method: str, request_id: int, params: dict[str, Any]) -> dict[str, Any]:
    send({"id": request_id, "method": method, "params": params})
    return receive(deadline, request_id)


class StoryProviderRegistry:
    """Routes story generation to local or opt-in remote providers."""

    def __init__(self, ollama: OllamaClient | None = None, environ: dict[str, str] | None = None) -> None:
        self.ollama = ollama or OllamaClient()
        self.env = dict(os.environ if environ is None else environ)
        self.codex = _CodexAppServer(self.env)

    def list_providers(self) -> list[dict[str, Any]]:
        try:
            ollama_models = self.ollama.list_models()
            ollama_available = True
        except OllamaError:
            ollama_models, ollama_available = [], False
        try:
            hf_local_models = _model_names(_local_hf_base_url(self.env), self.env.get("LKE_HF_LOCAL_API_KEY"))
            hf_local_available = True
        except StoryProviderError:
            hf_local_models, hf_local_available = [], False
        return [
            {"id": "ollama", "label": "Ollama (local)", "local": True, "available": ollama_available,
             "models": ollama_models, "default_model": ollama_models[0] if ollama_models else "",
             "setup": "Install a model in Ollama and run its local service."},
            {"id": "huggingface_local", "label": "Hugging Face model (local server)", "local": True,
             "available": hf_local_available, "models": hf_local_models,
             "default_model": hf_local_models[0] if hf_local_models else "",
             "setup": "Run a local OpenAI-compatible Hugging Face server; default: http://127.0.0.1:8000/v1."},
            {"id": "openai", "label": "OpenAI API", "local": False,
             "available": bool(self.env.get("OPENAI_API_KEY")), "models": [],
             "default_model": self.env.get("LKE_OPENAI_MODEL", ""),
             "setup": "Set OPENAI_API_KEY in the environment before starting Story Studio."},
            {"id": "claude", "label": "Claude API", "local": False,
             "available": bool(self.env.get("ANTHROPIC_API_KEY")), "models": [],
             "default_model": self.env.get("LKE_ANTHROPIC_MODEL", ""),
             "setup": "Set ANTHROPIC_API_KEY in the environment before starting Story Studio."},
            {"id": "huggingface", "label": "Hugging Face Inference Providers", "local": False,
             "available": bool(self.env.get("HF_TOKEN")), "models": [],
             "default_model": self.env.get("LKE_HF_MODEL", ""),
             "setup": "Set HF_TOKEN in the environment and enter a supported model repository ID."},
            {"id": "codex", "label": "Codex app-server", "local": True,
             "available": bool(self.env.get("LKE_CODEX_APP_SERVER_EXECUTABLE") or shutil.which("codex")),
             "models": [], "default_model": self.env.get("LKE_CODEX_MODEL", ""),
             "setup": "Sign in to Codex and make the Codex CLI available on PATH."},
        ]

    def generate(self, provider: str, model: str, messages: list[dict[str, str]]) -> str:
        if provider not in _PROVIDER_IDS:
            raise StoryProviderError("Choose a supported story provider.")
        if provider == "ollama":
            try:
                return self.ollama.generate(_validated_model(model), _validated_messages(messages))
            except OllamaError as error:
                raise StoryProviderError(str(error)) from error
        if provider == "openai":
            key = self.env.get("OPENAI_API_KEY", "")
            if not key:
                raise StoryProviderError("Set OPENAI_API_KEY before using the OpenAI API.")
            return _openai_responses(model, messages, key)
        if provider == "claude":
            key = self.env.get("ANTHROPIC_API_KEY", "")
            if not key:
                raise StoryProviderError("Set ANTHROPIC_API_KEY before using Claude.")
            return _anthropic_messages(model, messages, key)
        if provider == "huggingface":
            key = self.env.get("HF_TOKEN", "")
            if not key:
                raise StoryProviderError("Set HF_TOKEN before using Hugging Face Inference Providers.")
            return _chat_completion(base_url="https://router.huggingface.co/v1", model=model,
                                    messages=messages, api_key=key)
        if provider == "huggingface_local":
            base_url = _local_hf_base_url(self.env)
            return _chat_completion(base_url=base_url, model=model, messages=messages,
                                    api_key=self.env.get("LKE_HF_LOCAL_API_KEY"))
        return self.codex.generate(model, messages)

    def generate_json(self, provider: str, model: str, messages: list[dict[str, str]]) -> dict[str, Any]:
        checked = _validated_messages(messages)
        if provider == "ollama":
            try:
                return self.ollama.generate_json(_validated_model(model), checked)
            except OllamaError as error:
                raise StoryProviderError(str(error)) from error
        json_messages = [*checked, {"role": "system", "content": "Return exactly one valid JSON object and no markdown."}]
        content = self.generate(provider, model, json_messages)
        start = content.find("{")
        if start < 0:
            raise StoryProviderError("The provider did not return a JSON object.")
        try:
            value, _ = json.JSONDecoder().raw_decode(content[start:])
        except json.JSONDecodeError as error:
            raise StoryProviderError("The provider returned invalid JSON.") from error
        if not isinstance(value, dict):
            raise StoryProviderError("The provider returned an invalid structured response.")
        return value
