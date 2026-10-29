"""Contract tests for the loopback-only Ollama adapter."""

import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
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
    def test_timeout_has_a_distinct_local_provider_error(self) -> None:
        with patch("lke.ai.ollama.urlopen", side_effect=TimeoutError):
            with self.assertRaisesRegex(OllamaError, "timed out"):
                OllamaClient().generate("llama3.2", [{"role": "user", "content": "Continue."}])

    def test_cancelled_generation_closes_the_active_local_response(self) -> None:
        class BlockingResponse:
            def __init__(self) -> None:
                self.read_started = threading.Event()
                self.closed = threading.Event()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

            def read(self) -> bytes:
                self.read_started.set()
                if not self.closed.wait(2):
                    return json.dumps({"message": {"content": "late response"}}).encode("utf-8")
                raise OSError("response closed")

            def close(self) -> None:
                self.closed.set()

        response = BlockingResponse()
        cancel_event = threading.Event()
        with patch("lke.ai.ollama.urlopen", return_value=response):
            with ThreadPoolExecutor(max_workers=1) as executor:
                request = executor.submit(
                    OllamaClient().generate, "llama3.2", [{"role": "user", "content": "Continue."}],
                    cancel_event=cancel_event,
                )
                self.assertTrue(response.read_started.wait(1))
                cancel_event.set()
                with self.assertRaisesRegex(OllamaError, "stopped"):
                    request.result(timeout=2)
        self.assertTrue(response.closed.is_set())

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

    def test_structured_generation_requests_json_and_parses_the_response(self) -> None:
        response = FakeResponse({"message": {"content": '{"entities":[],"claims":[]}'}})
        with patch("lke.ai.ollama.urlopen", return_value=response) as open_url:
            value = OllamaClient().generate_json("llama3.2", [{"role": "user", "content": "Extract."}])

        payload = json.loads(open_url.call_args.args[0].data)
        self.assertEqual(value, {"entities": [], "claims": []})
        self.assertEqual(payload["format"], "json")
        self.assertEqual(payload["options"]["num_predict"], 4000)

    def test_structured_generation_rejects_invalid_json(self) -> None:
        response = FakeResponse({"message": {"content": "not json"}})
        with patch("lke.ai.ollama.urlopen", return_value=response):
            with self.assertRaises(OllamaError):
                OllamaClient().generate_json("llama3.2", [{"role": "user", "content": "Extract."}])

    def test_model_name_cannot_redirect_provider_to_another_host(self) -> None:
        with patch("lke.ai.ollama.urlopen") as open_url:
            with self.assertRaises(OllamaError):
                OllamaClient().generate("https://example.com/model", [{"role": "user", "content": "Hi"}])

        open_url.assert_not_called()


if __name__ == "__main__":
    unittest.main()
