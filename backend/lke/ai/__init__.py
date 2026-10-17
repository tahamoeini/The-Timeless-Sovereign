"""AI provider adapters that return proposals without writing canonical data."""

from .ollama import OllamaClient, OllamaError

__all__ = ["OllamaClient", "OllamaError"]
