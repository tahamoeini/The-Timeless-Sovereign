"""Provider routing uses explicit destinations and never needs real credentials in tests."""

import io
import json
import queue
import subprocess
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

from lke.ai.providers import (
    StoryProviderError,
    StoryProviderRegistry,
    _CodexAppServer,
    _stop_codex_process,
    _anthropic_messages,
    _local_hf_base_url,
    _openai_responses,
    _request_json,
)


class FakeOllama:
    def list_models(self):
        return ["qwen-local"]

    def generate(self, model, messages, **kwargs):
        return f"{model}: story"

    def generate_json(self, model, messages, **kwargs):
        return {"ok": True}


class StoryProviderTests(unittest.TestCase):
    def test_provider_timeout_is_distinct_from_network_failure(self):
        with patch("lke.ai.providers.urlopen", side_effect=TimeoutError):
            with self.assertRaisesRegex(StoryProviderError, "timed out"):
                _request_json("https://provider.example")

    def test_cancelled_remote_request_closes_the_active_response(self):
        class BlockingResponse:
            def __init__(self):
                self.read_started = threading.Event()
                self.closed = threading.Event()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

            def read(self, _size):
                self.read_started.set()
                if not self.closed.wait(2):
                    return b"{}"
                raise OSError("response closed")

            def close(self):
                self.closed.set()

        response = BlockingResponse()
        cancel_event = threading.Event()
        with patch("lke.ai.providers.urlopen", return_value=response):
            with ThreadPoolExecutor(max_workers=1) as executor:
                request = executor.submit(_request_json, "https://provider.example", cancel_event=cancel_event)
                self.assertTrue(response.read_started.wait(1))
                cancel_event.set()
                with self.assertRaisesRegex(StoryProviderError, "stopped"):
                    request.result(timeout=2)
        self.assertTrue(response.closed.is_set())

    def test_provider_inventory_includes_codex_and_supported_cloud_and_local_options(self):
        with patch("lke.ai.providers._model_names", return_value=["hf-local"]), patch.object(_CodexAppServer, "list_models", return_value=["codex-model"]) as codex_discovery:
            registry = StoryProviderRegistry(FakeOllama(), {
                "LKE_CODEX_APP_SERVER_EXECUTABLE": "codex",
                "OPENAI_API_KEY": "test-only",
                "ANTHROPIC_API_KEY": "test-only",
                "HF_TOKEN": "test-only",
            })
            providers = {item["id"]: item for item in registry.list_providers()}

        self.assertEqual(set(providers), {"ollama", "huggingface_local", "openai", "claude", "huggingface", "codex"})
        self.assertEqual(providers["ollama"]["models"], ["qwen-local"])
        self.assertEqual(providers["huggingface_local"]["models"], ["hf-local"])
        self.assertTrue(providers["codex"]["available"])
        self.assertEqual(providers["codex"]["models"], [])
        codex_discovery.assert_not_called()
        self.assertEqual(providers["codex"]["default_model"], "auto")
        self.assertFalse(providers["codex"]["local"])

    def test_codex_model_catalog_paginates_and_excludes_hidden_or_invalid_models(self):
        class CapturingInput(io.StringIO):
            def close(self):
                self.sent = self.getvalue()
                super().close()

        writer = CapturingInput()
        responses = [
            {"id": 1, "result": {}},
            {"id": 2, "result": {"data": [
                {"model": "model-a", "displayName": "Model A", "defaultReasoningEffort": "medium",
                 "supportedReasoningEfforts": [{"reasoningEffort": "low", "description": "Faster"},
                                                {"reasoningEffort": "medium", "description": "Balanced"}]},
                {"model": "hidden-model", "hidden": True}, {"model": "invalid model"},
            ], "nextCursor": "page-two"}},
            {"id": 3, "result": {"data": [
                {"model": "model-b", "defaultReasoningEffort": "high",
                 "supportedReasoningEfforts": [{"reasoningEffort": "high", "description": "Deeper"}]},
                {"model": "model-a"},
            ], "nextCursor": None}},
        ]
        process = Mock(stdin=writer, stdout=io.StringIO("".join(json.dumps(item) + "\n" for item in responses)))
        process.poll.return_value = None
        with patch("lke.ai.providers.tempfile.TemporaryDirectory") as directory, patch("lke.ai.providers.subprocess.Popen", return_value=process) as start:
            directory.return_value.__enter__.return_value = "scratch"
            models = _CodexAppServer({"LKE_CODEX_APP_SERVER_EXECUTABLE": "codex", "OPENAI_API_KEY": "secret"}).list_model_options()
        self.assertEqual([item["model"] for item in models], ["model-a", "model-b"])
        self.assertEqual(models[0]["supported_reasoning_efforts"], ["low", "medium"])
        self.assertEqual(models[0]["default_reasoning_effort"], "medium")
        self.assertEqual(models[0]["effort_descriptions"]["low"], "Faster")
        sent = [json.loads(line) for line in writer.sent.splitlines()]
        self.assertEqual(sent[2]["method"], "model/list")
        self.assertEqual(sent[3]["params"]["cursor"], "page-two")
        self.assertNotIn("OPENAI_API_KEY", start.call_args.kwargs["env"])
        process.wait.assert_called_once_with(timeout=2)

    def test_codex_windows_timeout_stops_only_the_launched_process_tree(self):
        process = Mock(stdin=io.StringIO(), pid=1234)
        process.wait.side_effect = [subprocess.TimeoutExpired("codex", 2), 0]
        process.poll.return_value = None
        with patch("lke.ai.providers.os.name", "nt"), patch("lke.ai.providers.subprocess.run") as stop_tree:
            _stop_codex_process(process)
        self.assertEqual(stop_tree.call_args.args[0], ["taskkill", "/PID", "1234", "/T", "/F"])
        process.kill.assert_called_once()

    def test_codex_generation_sends_catalog_validated_effort_and_current_turn_shape(self):
        class CapturingInput(io.StringIO):
            def close(self):
                self.sent = self.getvalue()
                super().close()

        writer = CapturingInput()
        responses = [
            {"id": 1, "result": {}},
            {"id": 2, "result": {"data": [{
                "model": "model-a", "supportedReasoningEfforts": [
                    {"reasoningEffort": "low", "description": "Faster"},
                    {"reasoningEffort": "high", "description": "Deeper"},
                ],
            }], "nextCursor": None}},
            {"id": 12, "result": {"thread": {"id": "thread-1"}}},
            {"id": 13, "result": {}},
            {"method": "item/agentMessage/delta", "params": {"delta": "The story continues."}},
            {"method": "turn/completed", "params": {"turn": {"status": "completed"}}},
        ]
        process = Mock(stdin=writer, stdout=io.StringIO("".join(json.dumps(item) + "\n" for item in responses)))
        process.poll.return_value = None
        with patch("lke.ai.providers.tempfile.TemporaryDirectory") as directory, patch(
            "lke.ai.providers.subprocess.Popen", return_value=process,
        ):
            directory.return_value.__enter__.return_value = "scratch"
            result = _CodexAppServer({"LKE_CODEX_APP_SERVER_EXECUTABLE": "codex"}).generate(
                "model-a", [{"role": "user", "content": "Continue the scene."}], reasoning_effort="high",
            )

        self.assertEqual(result, "The story continues.")
        sent = [json.loads(line) for line in writer.sent.splitlines()]
        requests = {message["method"]: message for message in sent if "method" in message}
        self.assertNotIn("runtimeWorkspaceRoots", requests["thread/start"]["params"])
        self.assertEqual(requests["turn/start"]["params"]["effort"], "high")

    def test_codex_generation_rejects_an_effort_the_selected_model_does_not_support(self):
        class CapturingInput(io.StringIO):
            def close(self):
                self.sent = self.getvalue()
                super().close()

        writer = CapturingInput()
        responses = [
            {"id": 1, "result": {}},
            {"id": 2, "result": {"data": [{
                "model": "model-a", "supportedReasoningEfforts": [{"reasoningEffort": "low", "description": "Faster"}],
            }], "nextCursor": None}},
        ]
        process = Mock(stdin=writer, stdout=io.StringIO("".join(json.dumps(item) + "\n" for item in responses)))
        process.poll.return_value = None
        with patch("lke.ai.providers.tempfile.TemporaryDirectory") as directory, patch(
            "lke.ai.providers.subprocess.Popen", return_value=process,
        ):
            directory.return_value.__enter__.return_value = "scratch"
            with self.assertRaisesRegex(StoryProviderError, "not supported"):
                _CodexAppServer({"LKE_CODEX_APP_SERVER_EXECUTABLE": "codex"}).generate(
                    "model-a", [{"role": "user", "content": "Continue the scene."}], reasoning_effort="ultra",
                )
        sent = [json.loads(line) for line in writer.sent.splitlines()]
        self.assertNotIn("thread/start", [message.get("method") for message in sent])

    def test_codex_cancellation_stops_the_ephemeral_app_server(self):
        responses = queue.Queue()
        turn_started = threading.Event()

        class CapturingInput:
            def __init__(self):
                self.closed = False

            def write(self, line):
                message = json.loads(line)
                if message.get("method") == "initialize":
                    responses.put(json.dumps({"id": 1, "result": {}}) + "\n")
                elif message.get("method") == "model/list":
                    responses.put(json.dumps({"id": 2, "result": {"data": [{"model": "model-a", "supportedReasoningEfforts": []}], "nextCursor": None}}) + "\n")
                elif message.get("method") == "thread/start":
                    responses.put(json.dumps({"id": 12, "result": {"thread": {"id": "thread-1"}}}) + "\n")
                elif message.get("method") == "turn/start":
                    turn_started.set()

            def flush(self):
                pass

            def close(self):
                self.closed = True
                responses.put(None)

        class BlockingOutput:
            def __iter__(self):
                return self

            def __next__(self):
                line = responses.get(timeout=4)
                if line is None:
                    raise StopIteration
                return line

        writer = CapturingInput()
        process = Mock(stdin=writer, stdout=BlockingOutput(), pid=1234)
        process.poll.return_value = 0
        process.wait.return_value = 0
        cancel_event = threading.Event()
        codex = _CodexAppServer({"LKE_CODEX_APP_SERVER_EXECUTABLE": "codex"})

        with patch("lke.ai.providers.tempfile.TemporaryDirectory") as directory, patch(
            "lke.ai.providers.subprocess.Popen", return_value=process,
        ):
            directory.return_value.__enter__.return_value = "scratch"
            with ThreadPoolExecutor(max_workers=1) as executor:
                generation = executor.submit(
                    codex.generate, "auto", [{"role": "user", "content": "Continue."}],
                    cancel_event=cancel_event,
                )
                self.assertTrue(turn_started.wait(1))
                cancel_event.set()
                with self.assertRaisesRegex(StoryProviderError, "stopped"):
                    generation.result(timeout=2)

        self.assertTrue(writer.closed)
        process.wait.assert_called_once_with(timeout=2)

    def test_codex_catalog_failure_keeps_automatic_default_available(self):
        registry = StoryProviderRegistry(FakeOllama(), {"LKE_CODEX_APP_SERVER_EXECUTABLE": "codex"})
        with patch("lke.ai.providers._model_names", return_value=[]), patch.object(registry.codex, "list_models", side_effect=StoryProviderError("unavailable")):
            provider = next(item for item in registry.list_providers() if item["id"] == "codex")
            with self.assertRaises(StoryProviderError):
                registry.discover_models("codex")
        self.assertEqual(provider["models"], [])
        self.assertEqual(provider["default_model"], "auto")

    def test_remote_model_discovery_is_explicit_and_uses_configured_provider(self):
        registry = StoryProviderRegistry(FakeOllama(), {"OPENAI_API_KEY": "test-openai", "ANTHROPIC_API_KEY": "test-claude"})
        with patch("lke.ai.providers._request_json", return_value={"data": [{"id": "model-b"}, {"id": "model-a"}, {"id": "bad name"}]}) as fetch:
            self.assertEqual(registry.discover_models("openai"), ["model-a", "model-b"])
        self.assertEqual(fetch.call_args.args[0], "https://api.openai.com/v1/models")
        self.assertEqual(fetch.call_args.kwargs["headers"]["Authorization"], "Bearer test-openai")
        self.assertFalse(fetch.call_args.kwargs["follow_redirects"])

        pages = [{"data": [{"id": "claude-a"}], "has_more": True, "last_id": "claude-a"},
                 {"data": [{"id": "claude-b"}], "has_more": False}]
        with patch("lke.ai.providers._request_json", side_effect=pages) as fetch:
            self.assertEqual(registry.discover_models("claude"), ["claude-a", "claude-b"])
        self.assertIn("after_id=claude-a", fetch.call_args.args[0])
        self.assertEqual(fetch.call_args.kwargs["headers"]["x-api-key"], "test-claude")
        self.assertFalse(fetch.call_args.kwargs["follow_redirects"])

    def test_remote_discovery_rejects_missing_credentials_and_unsupported_providers(self):
        registry = StoryProviderRegistry(FakeOllama(), {})
        with patch("lke.ai.providers._request_json") as fetch:
            for provider in ("openai", "claude", "huggingface"):
                with self.subTest(provider=provider), self.assertRaises(StoryProviderError):
                    registry.discover_models(provider)
        fetch.assert_not_called()

    def test_local_hugging_face_url_is_loopback_v1_only(self):
        self.assertEqual(_local_hf_base_url({"LKE_HF_LOCAL_BASE_URL": "http://localhost:8000/v1/"}), "http://localhost:8000/v1")
        for value in (
            "https://localhost:8000/v1",
            "http://example.com:8000/v1",
            "http://127.0.0.1:8000/v1evil",
            "http://user:secret@127.0.0.1:8000/v1",
            "http://127.0.0.1:8000/v1?token=x",
        ):
            with self.subTest(value=value), self.assertRaises(StoryProviderError):
                _local_hf_base_url({"LKE_HF_LOCAL_BASE_URL": value})

    def test_openai_responses_parser_and_instruction_mapping(self):
        response = {"output": [{"type": "message", "content": [
            {"type": "output_text", "text": "The gate opens."},
        ]}]}
        with patch("lke.ai.providers._request_json", return_value=response) as request_json:
            answer = _openai_responses("gpt-test", [
                {"role": "system", "content": "Keep the hero's secret."},
                {"role": "user", "content": "Open the gate."},
            ], "not-a-real-key")

        self.assertEqual(answer, "The gate opens.")
        self.assertEqual(request_json.call_args.args[0], "https://api.openai.com/v1/responses")
        payload = request_json.call_args.kwargs["payload"]
        self.assertEqual(payload["instructions"], "Keep the hero's secret.")
        self.assertEqual(payload["input"], [{"role": "user", "content": "Open the gate."}])
        self.assertNotIn("not-a-real-key", str(payload))
        self.assertEqual(request_json.call_args.kwargs["headers"]["Authorization"], "Bearer not-a-real-key")

    def test_anthropic_messages_parser(self):
        with patch("lke.ai.providers._request_json", return_value={
            "content": [{"type": "text", "text": "The rain begins."}],
        }) as request_json:
            answer = _anthropic_messages("claude-test", [
                {"role": "system", "content": "Narrate in the past tense."},
                {"role": "user", "content": "Look outside."},
            ], "not-a-real-key")

        self.assertEqual(answer, "The rain begins.")
        self.assertEqual(request_json.call_args.kwargs["payload"]["system"], "Narrate in the past tense.")
        self.assertEqual(request_json.call_args.kwargs["headers"]["anthropic-version"], "2023-06-01")

    def test_local_hugging_face_request_disables_redirects(self):
        registry = StoryProviderRegistry(FakeOllama(), {"LKE_HF_LOCAL_BASE_URL": "http://127.0.0.1:8000/v1"})
        with patch("lke.ai.providers._chat_completion", return_value="The story continues.") as chat:
            answer = registry.generate("huggingface_local", "local-model", [{"role": "user", "content": "Go."}])
        self.assertEqual(answer, "The story continues.")
        self.assertFalse(chat.call_args.kwargs["follow_redirects"])

    def test_openai_provider_needs_a_server_side_key(self):
        registry = StoryProviderRegistry(FakeOllama(), {})
        with self.assertRaisesRegex(StoryProviderError, "OPENAI_API_KEY"):
            registry.generate("openai", "gpt-test", [{"role": "user", "content": "Go."}])


if __name__ == "__main__":
    unittest.main()
