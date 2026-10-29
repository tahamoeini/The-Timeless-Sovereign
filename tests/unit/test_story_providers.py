"""Provider routing uses explicit destinations and never needs real credentials in tests."""

import io
import json
import unittest
from unittest.mock import Mock, patch

from lke.ai.providers import (
    StoryProviderError,
    StoryProviderRegistry,
    _CodexAppServer,
    _anthropic_messages,
    _local_hf_base_url,
    _openai_responses,
)


class FakeOllama:
    def list_models(self):
        return ["qwen-local"]

    def generate(self, model, messages):
        return f"{model}: story"

    def generate_json(self, model, messages):
        return {"ok": True}


class StoryProviderTests(unittest.TestCase):
    def test_provider_inventory_includes_codex_and_supported_cloud_and_local_options(self):
        with patch("lke.ai.providers._model_names", return_value=["hf-local"]), patch.object(_CodexAppServer, "list_models", return_value=["codex-model"]):
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
        self.assertEqual(providers["codex"]["models"], ["codex-model"])
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
            {"id": 2, "result": {"data": [{"model": "model-a"}, {"model": "hidden-model", "hidden": True}, {"model": "invalid model"}], "nextCursor": "page-two"}},
            {"id": 3, "result": {"data": [{"model": "model-b"}, {"model": "model-a"}], "nextCursor": None}},
        ]
        process = Mock(stdin=writer, stdout=io.StringIO("".join(json.dumps(item) + "\n" for item in responses)))
        process.poll.return_value = None
        with patch("lke.ai.providers.tempfile.TemporaryDirectory") as directory, patch("lke.ai.providers.subprocess.Popen", return_value=process) as start:
            directory.return_value.__enter__.return_value = "scratch"
            models = _CodexAppServer({"LKE_CODEX_APP_SERVER_EXECUTABLE": "codex", "OPENAI_API_KEY": "secret"}).list_models()
        self.assertEqual(models, ["model-a", "model-b"])
        sent = [json.loads(line) for line in writer.sent.splitlines()]
        self.assertEqual(sent[2]["method"], "model/list")
        self.assertEqual(sent[3]["params"]["cursor"], "page-two")
        self.assertNotIn("OPENAI_API_KEY", start.call_args.kwargs["env"])
        process.terminate.assert_called_once()

    def test_codex_catalog_failure_keeps_automatic_default_available(self):
        registry = StoryProviderRegistry(FakeOllama(), {"LKE_CODEX_APP_SERVER_EXECUTABLE": "codex"})
        with patch("lke.ai.providers._model_names", return_value=[]), patch.object(registry.codex, "list_models", side_effect=StoryProviderError("unavailable")):
            provider = next(item for item in registry.list_providers() if item["id"] == "codex")
        self.assertEqual(provider["models"], [])
        self.assertEqual(provider["default_model"], "auto")

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
