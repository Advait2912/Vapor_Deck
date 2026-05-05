from .base import BaseProvider
from .providers.google import GoogleProvider
from .providers.ollama import OllamaProvider

# Registry of available providers
PROVIDERS: dict[str, type[BaseProvider]] = {
    "google": GoogleProvider,
    "ollama": OllamaProvider,
}

# Cache: model_string → provider instance (instantiated once, reused)
_cache: dict[str, BaseProvider] = {}


def get_model(model_string: str) -> BaseProvider:
    """
    Return a cached provider instance for the given model string.

    Format: "provider/model-name"
    Examples:
        "google/gemini-2.0-flash"
        "google/gemma-4"
        "ollama/llama3.1:8b"
        "ollama/llava:13b"
    """
    if model_string not in _cache:
        if "/" not in model_string:
            raise ValueError(
                f"Invalid model string '{model_string}'. "
                f"Expected format: 'provider/model-name'"
            )
        provider_name, model_name = model_string.split("/", 1)
        if provider_name not in PROVIDERS:
            raise ValueError(
                f"Unknown provider '{provider_name}'. "
                f"Available: {list(PROVIDERS.keys())}"
            )
        _cache[model_string] = PROVIDERS[provider_name](model_name)

    return _cache[model_string]


def list_providers() -> list[str]:
    return list(PROVIDERS.keys())
