"""Contract tests for the loopback-only Ollama adapter."""

import json
import unittest
from unittest.mock import patch

from lke.ai import OllamaClient, OllamaError


class FakeResponse:
    def __init__(self, body: dict) -> None:
        self.body = json.dumps(body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self.body


class OllamaClientTests(unittest.TestCase):
    def test_model_discovery_reads_local_tags(self) -> None:
        with patch("lke.ai.ollama.urlopen", return_value=FakeResponse({"models": [{"name": "llama3.2"}]})) as open_url:
            names = OllamaClient().list_models()

        self.assertEqual(names, ["llama3.2"])
        self.assertTrue(open_url.call_args.args[0].full_url.startswith("http://127.0.0.1:11434/"))

    def test_story_generation_uses_non_streaming_local_chat(self) -> None:
        response = FakeResponse({"message": {"content": "The room falls quiet."}})
        with patch("lke.ai.ollama.urlopen", return_value=response) as open_url:
            text = OllamaClient().generate("llama3.2", [{"role": "user", "content": "Continue."}])

        request = open_url.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual(text, "The room falls quiet.")
        self.assertEqual(request.full_url, "http://127.0.0.1:11434/api/chat")
        self.assertFalse(payload["stream"])
        self.assertEqual(payload["model"], "llama3.2")

    def test_model_name_cannot_redirect_provider_to_another_host(self) -> None:
        with patch("lke.ai.ollama.urlopen") as open_url:
            with self.assertRaises(OllamaError):
                OllamaClient().generate("https://example.com/model", [{"role": "user", "content": "Hi"}])

        open_url.assert_not_called()


if __name__ == "__main__":
    unittest.main()
