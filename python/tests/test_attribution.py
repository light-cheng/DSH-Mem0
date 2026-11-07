"""Failure attribution: which component (embedder, LLM, vector store) failed.

Uses fake components shaped like Mem0's (embedding_model.embed,
llm.generate_response, vector_store.search/insert); no mem0ai install needed.
"""
import os
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mem0_sidecar as sidecar
from test_handler import FakeService, request


def setUpModule():
    sidecar.logger.disabled = True


class ConnectError(Exception):
    pass


class FakeEmbedder:
    def __init__(self, error=None, delay=0.0):
        self.error = error
        self.delay = delay

    def embed(self, text, action="add"):
        if self.delay:
            time.sleep(self.delay)
        if self.error:
            raise self.error
        return [0.0] * 4


class FakeLlm:
    def __init__(self, error=None):
        self.error = error

    def generate_response(self, messages, **kwargs):
        if self.error:
            raise self.error
        return "{}"


class FakeVectorStore:
    def __init__(self, search_error=None, insert_error=None):
        self.search_error = search_error
        self.insert_error = insert_error

    def search(self, *args, **kwargs):
        if self.search_error:
            raise self.search_error
        return []

    def insert(self, *args, **kwargs):
        if self.insert_error:
            raise self.insert_error


class FakeMemory:
    """Mem0's Memory flow, reduced: search = embed + vector search; add = LLM + embed + store."""

    def __init__(self, embedder, llm, vector_store):
        self.embedding_model = embedder
        self.llm = llm
        self.vector_store = vector_store

    def search(self, query):
        vector = self.embedding_model.embed(query, "search")
        return self.vector_store.search(query=query, vectors=vector)

    def add(self, text):
        self.llm.generate_response([{"role": "user", "content": text}])
        vector = self.embedding_model.embed(text, "add")
        self.vector_store.insert(vectors=[vector])


def instrumented(**parts):
    tracker = sidecar.StepTracker()
    memory = FakeMemory(
        parts.get("embedder") or FakeEmbedder(),
        parts.get("llm") or FakeLlm(),
        parts.get("vector_store") or FakeVectorStore(),
    )
    sidecar.instrument_memory(memory, tracker)
    return memory, tracker


def failure_of(fn):
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        return exc
    raise AssertionError("expected a failure")


COMPONENTS = {
    "llm": {"provider": "openai", "endpoint": "127.0.0.1:3425"},
    "embedder": {"provider": "ollama", "endpoint": "127.0.0.1:11434"},
    "vector_store": {"provider": "qdrant", "endpoint": "127.0.0.1:6333"},
}


class AttributionTests(unittest.TestCase):
    def test_embedder_failure_during_search(self):
        memory, _ = instrumented(embedder=FakeEmbedder(ConnectError("[Errno 61] Connection refused")))
        exc = failure_of(lambda: memory.search("tea"))
        self.assertEqual(sidecar.attribute_exception(exc), {"component": "embedder", "step": "embed"})
        payload = sidecar.error_payload(exc, COMPONENTS)
        self.assertEqual(payload["provider"], "ollama")
        self.assertEqual(payload["endpoint"], "127.0.0.1:11434")

    def test_vector_store_failure_during_search(self):
        memory, _ = instrumented(
            vector_store=FakeVectorStore(search_error=ValueError("Collection dsh_mem0 not found"))
        )
        exc = failure_of(lambda: memory.search("tea"))
        self.assertEqual(sidecar.attribute_exception(exc), {"component": "vector_store", "step": "search"})

    def test_llm_failure_during_extraction(self):
        memory, _ = instrumented(llm=FakeLlm(RuntimeError("Error code: 429 - rate limit reached")))
        exc = failure_of(lambda: memory.add("I like oolong"))
        self.assertEqual(sidecar.attribute_exception(exc), {"component": "llm", "step": "llm_extract"})
        self.assertEqual(sidecar.error_payload(exc, COMPONENTS)["provider"], "openai")

    def test_vector_store_failure_while_storing(self):
        memory, _ = instrumented(vector_store=FakeVectorStore(insert_error=ConnectError("Connection refused")))
        exc = failure_of(lambda: memory.add("I like oolong"))
        self.assertEqual(sidecar.attribute_exception(exc), {"component": "vector_store", "step": "store"})

    def test_wrapped_and_chained_errors_keep_the_innermost_component(self):
        memory, _ = instrumented(embedder=FakeEmbedder(ConnectError("refused")))

        def outer():
            try:
                memory.search("tea")
            except ConnectError as exc:
                raise RuntimeError("search failed") from exc

        exc = failure_of(outer)
        self.assertEqual(sidecar.attribute_exception(exc)["component"], "embedder")

    def test_unattributed_error_has_no_component(self):
        self.assertEqual(sidecar.attribute_exception(RuntimeError("x")), {})

    def test_steps_show_a_slow_embedder_while_it_runs(self):
        memory, tracker = instrumented(embedder=FakeEmbedder(delay=0.3))
        thread = threading.Thread(target=lambda: memory.search("tea"))
        thread.start()
        time.sleep(0.1)
        steps = tracker.snapshot()
        thread.join()
        self.assertEqual(len(steps), 1)
        self.assertEqual((steps[0]["component"], steps[0]["step"]), ("embedder", "embed"))
        self.assertGreaterEqual(steps[0]["elapsedMs"], 50)
        self.assertEqual(tracker.snapshot(), [])

    def test_describe_components_reads_endpoints_without_credentials(self):
        config = {
            "llm": {"provider": "openai", "config": {"openai_base_url": "https://user:pw@api.example.com/v1", "api_key": "sk-secret123456"}},
            "embedder": {"provider": "ollama", "config": {"ollama_base_url": "http://localhost:11434"}},
            "vector_store": {"provider": "qdrant", "config": {"host": "127.0.0.1", "port": 6333}},
        }
        described = sidecar.describe_components(config)
        self.assertEqual(described["llm"], {"provider": "openai", "endpoint": "api.example.com"})
        self.assertEqual(described["embedder"]["endpoint"], "localhost:11434")
        self.assertEqual(described["vector_store"]["endpoint"], "127.0.0.1:6333")
        self.assertNotIn("sk-secret", repr(described))


class RedactionTests(unittest.TestCase):
    def test_error_text_is_redacted(self):
        home = os.path.expanduser("~")
        text = sidecar.redact_error(
            f"auth failed api_key=sk-abcdef123456 Authorization: Bearer abcdefghijkl1234 at {home}/x and /home/bob/y"
        )
        self.assertNotIn("sk-abcdef123456", text)
        self.assertNotIn("abcdefghijkl1234", text)
        self.assertNotIn(home, text)
        self.assertNotIn("bob", text)
        self.assertLessEqual(len(sidecar.redact_error("x" * 2000)), 500)


class HandlerAttributionTests(unittest.TestCase):
    def test_component_failure_is_a_500_with_component_and_step(self):
        service = FakeService()
        memory, tracker = instrumented(embedder=FakeEmbedder(ConnectError("Connection refused sk-abcdef123456")))
        service.components = COMPONENTS
        service.steps = tracker
        service.search = lambda query, filters, top_k, threshold: memory.search(query)
        status, body = request(service, "POST", "/search", {"query": "tea"})
        self.assertEqual(status, 500)
        self.assertEqual(body["component"], "embedder")
        self.assertEqual(body["step"], "embed")
        self.assertEqual(body["provider"], "ollama")
        self.assertEqual(body["endpoint"], "127.0.0.1:11434")
        self.assertNotIn("sk-abcdef123456", body["error"])

    def test_component_value_error_is_not_a_400(self):
        service = FakeService()
        memory, _ = instrumented(vector_store=FakeVectorStore(search_error=ValueError("Collection not found")))
        service.search = lambda query, filters, top_k, threshold: memory.search(query)
        status, body = request(service, "POST", "/search", {"query": "tea"})
        self.assertEqual(status, 500)
        self.assertEqual(body["component"], "vector_store")

    def test_steps_route(self):
        service = FakeService()
        service.steps = sidecar.StepTracker()
        service.components = COMPONENTS
        token = service.steps.start("embedder", "embed")
        status, body = request(service, "GET", "/steps")
        service.steps.finish(token)
        self.assertEqual(status, 200)
        self.assertEqual(body["steps"][0]["component"], "embedder")
        self.assertEqual(body["components"]["vector_store"]["provider"], "qdrant")



class LogScrubTests(unittest.TestCase):
    def test_quoted_memory_text_is_removed(self):
        cases = {
            "Entity upsert failed for 'Alice from Lisbon': timeout": "Entity upsert failed for '[…]': timeout",
            "Entity upsert failed for 'it's Bob' (async): boom": "Entity upsert failed for '[…]' (async): boom",
            "Skipping invalid message format: {'role': 'user', 'content': 'secret plans'}": "Skipping invalid message format: […]",
            "Skipping duplicate memory (hash match): User likes tea": "Skipping duplicate memory (hash match): […]",
            "1 validation error\n  Input should be a valid string [type=string_type, input_value='my diary text', input_type=str]":
                "1 validation error\n  Input should be a valid string [type=string_type, input_value=[…], input_type=str]",
            "Error parsing extraction response: Expecting value: line 1 column 1 (char 0)":
                "Error parsing extraction response: Expecting value: line 1 column 1 (char 0)",
        }
        for raw, expected in cases.items():
            self.assertEqual(sidecar.scrub_log_text(raw), expected)

    def test_filter_rewrites_records_and_caps_other_libraries(self):
        import logging

        scrubber = sidecar.LogScrubber()
        record = logging.LogRecord("mem0.memory.main", logging.WARNING, __file__, 1, "Entity upsert failed for '%s': %s", ("Alice", "x"), None)
        scrubber.filter(record)
        self.assertEqual(record.getMessage(), "Entity upsert failed for '[…]': x")
        long = logging.LogRecord("openai", logging.ERROR, __file__, 1, "y" * 2000, None, None)
        scrubber.filter(long)
        self.assertEqual(len(long.getMessage()), sidecar.THIRD_PARTY_LOG_LIMIT)
        own = logging.LogRecord(sidecar.logger.name, logging.ERROR, __file__, 1, "z" * 2000, None, None)
        scrubber.filter(own)
        self.assertEqual(len(own.getMessage()), 2000)


if __name__ == "__main__":
    unittest.main()
