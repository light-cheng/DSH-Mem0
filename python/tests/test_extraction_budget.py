"""Extraction output budget: finish_reason / usage, max_tokens, reasoning_effort.

No mem0ai install needed: a fake OpenAI-style client stands in for the LLM
and a fake Memory calls it the way Mem0 2.2.1's OpenAILLM does.
"""
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mem0_sidecar as sidecar

MESSAGES = {"messages": [{"role": "user", "content": "I write release notes in English and Chinese"}], "infer": True}
GOOD = '{"memory": [{"text": "writes release notes in English and Chinese"}]}'


def completion(content, finish="stop", prompt=9191, completion_tokens=812, reasoning=None):
    details = SimpleNamespace(reasoning_tokens=reasoning) if reasoning is not None else None
    usage = SimpleNamespace(prompt_tokens=prompt, completion_tokens=completion_tokens, completion_tokens_details=details)
    choice = SimpleNamespace(finish_reason=finish, message=SimpleNamespace(content=content))
    return SimpleNamespace(choices=[choice], usage=usage)


class FakeCompletions:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def create(self, **params):
        self.calls.append(dict(params))
        reply = self.replies.pop(0)
        return reply(params) if callable(reply) else reply


class FakeOpenAILLM:
    """Builds params like Mem0 2.2.1 OpenAILLM (non-reasoning model)."""

    def __init__(self, replies, max_tokens=2000, reasoning_effort=None, reasoning_model=False):
        self.completions = FakeCompletions(replies)
        self.client = SimpleNamespace(chat=SimpleNamespace(completions=self.completions))
        self.config = SimpleNamespace(max_tokens=max_tokens, reasoning_effort=reasoning_effort)
        self.reasoning_model = reasoning_model

    def generate_response(self, messages=None, response_format=None, **kwargs):
        if self.reasoning_model:
            params = {"messages": messages}
            if self.config.reasoning_effort:
                params["reasoning_effort"] = self.config.reasoning_effort
        else:
            params = {"temperature": 0.1, "top_p": 0.1, "max_tokens": self.config.max_tokens, **kwargs}
        params.update({"model": "workbuddy/deepseek-v4.1-flash", "messages": messages})
        if response_format:
            params["response_format"] = response_format
        return self.client.chat.completions.create(**params).choices[0].message.content


class FakeMemory:
    def __init__(self, llm, store_when_parsed=True):
        self.llm = llm
        self.store_when_parsed = store_when_parsed

    def add(self, messages, **_kwargs):
        answer = self.llm.generate_response(messages=[{"role": "user", "content": "x"}], response_format={"type": "json_object"})
        facts, _reason = sidecar.inspect_extraction(answer)
        if facts and self.store_when_parsed:
            return {"results": [{"id": str(i), "memory": "m", "event": "ADD"} for i, _ in enumerate(facts)]}
        return {"results": []}


def service_with(memory, reasoning_effort=None):
    service = sidecar.Mem0Service.__new__(sidecar.Mem0Service)
    service.user_id = "dsh-mem0-truncation-test-user"
    service.agent_id = "dsh"
    service._write_lock = threading.RLock()
    service.write_memory = memory
    service._llm_responses = None
    service._llm_stats = None
    service._max_tokens_override = None
    service.reasoning_effort = reasoning_effort
    sidecar.record_llm_responses(memory.llm, service._record_llm_response)
    sidecar.instrument_llm_client(memory.llm, service)
    return service


class CompletionStatsTests(unittest.TestCase):
    def test_reads_finish_reason_and_usage(self):
        stats = sidecar.completion_stats(completion("{", "length", 9191, 2000, 1697), {"max_tokens": 2000})
        self.assertEqual(stats, {
            "maxTokens": 2000, "finishReason": "length",
            "promptTokens": 9191, "completionTokens": 2000, "reasoningTokens": 1697,
        })

    def test_dicts_and_max_completion_tokens(self):
        response = {"choices": [{"finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 7, "reasoning_tokens": 3}}
        stats = sidecar.completion_stats(response, {"max_completion_tokens": 8000, "reasoning_effort": "none"})
        self.assertEqual(stats, {
            "maxTokens": 8000, "reasoningEffort": "none", "finishReason": "stop",
            "promptTokens": 5, "completionTokens": 7, "reasoningTokens": 3,
        })

    def test_missing_or_odd_values_are_left_out(self):
        self.assertEqual(sidecar.completion_stats(None, {}), {})
        odd = {"choices": [{"finish_reason": "x" * 40}], "usage": {"completion_tokens": -1, "prompt_tokens": True}}
        self.assertEqual(sidecar.completion_stats(odd, {"max_tokens": "8000"}), {})

    def test_describe_stats_is_numbers_only(self):
        text = sidecar.describe_stats({"finishReason": "length", "maxTokens": 2000, "completionTokens": 2000, "reasoningTokens": 1697, "promptTokens": 9191})
        self.assertEqual(text, "finish_reason=length, 2000/2000 output tokens (1697 reasoning), 9191 prompt tokens")
        self.assertIn("no finish_reason", sidecar.describe_stats(None))


class ExtractionBudgetTests(unittest.TestCase):
    def test_length_with_reasoning_is_truncated_with_stats(self):
        llm = FakeOpenAILLM([completion('{"memory": [{"text": "writes rel', "length", 9191, 2000, 1697)])
        service = service_with(FakeMemory(llm))
        with self.assertRaises(sidecar.LLMExtractionError) as caught:
            service.add(dict(MESSAGES))
        error = caught.exception
        self.assertEqual(error.reason, "truncated")
        self.assertTrue(error.retryable)
        self.assertEqual(error.stats["finishReason"], "length")
        self.assertEqual(error.stats["reasoningTokens"], 1697)
        self.assertEqual(error.stats["maxTokens"], 2000)
        self.assertIsNone(service._llm_stats)

    def test_thinking_ate_the_whole_budget(self):
        # No answer text at all: Mem0 sees "", which is "empty" unless the
        # budget ran out.
        llm = FakeOpenAILLM([completion("", "length", 9191, 2000, 2000)])
        with self.assertRaises(sidecar.LLMExtractionError) as caught:
            service_with(FakeMemory(llm)).add(dict(MESSAGES))
        self.assertEqual(caught.exception.reason, "truncated")

    def test_empty_answer_that_stopped_is_still_empty(self):
        llm = FakeOpenAILLM([completion("", "stop", 9191, 3)])
        with self.assertRaises(sidecar.LLMExtractionError) as caught:
            service_with(FakeMemory(llm)).add(dict(MESSAGES))
        self.assertEqual(caught.exception.reason, "empty")
        self.assertEqual(caught.exception.stats["finishReason"], "stop")

    def test_refusal_keeps_its_reason(self):
        llm = FakeOpenAILLM([completion("I'm sorry, but I can't help with that.", "length", 10, 2000)])
        with self.assertRaises(sidecar.LLMExtractionError) as caught:
            service_with(FakeMemory(llm)).add(dict(MESSAGES))
        self.assertEqual(caught.exception.reason, "refusal")

    def test_request_override_replaces_the_budget_for_one_add(self):
        llm = FakeOpenAILLM([completion(GOOD), completion(GOOD)])
        service = service_with(FakeMemory(llm))
        out = service.add({**MESSAGES, "llm_max_tokens": 16000})
        self.assertEqual(out["summary"]["add"], 1)
        self.assertEqual(llm.completions.calls[0]["max_tokens"], 16000)
        service.add(dict(MESSAGES))
        self.assertEqual(llm.completions.calls[1]["max_tokens"], 2000)

    def test_override_is_clamped_and_validated(self):
        self.assertEqual(sidecar.clamp_max_tokens(10), sidecar.MIN_EXTRACT_MAX_TOKENS)
        self.assertEqual(sidecar.clamp_max_tokens(10**9), sidecar.MAX_EXTRACT_MAX_TOKENS)
        for bad in (None, 0, -5, "4000", 4000.0, True):
            self.assertIsNone(sidecar.clamp_max_tokens(bad))

    def test_reasoning_effort_is_sent_when_mem0_does_not(self):
        llm = FakeOpenAILLM([completion(GOOD, reasoning=0)])
        service_with(FakeMemory(llm), reasoning_effort="none").add(dict(MESSAGES))
        self.assertEqual(llm.completions.calls[0]["reasoning_effort"], "none")

    def test_reasoning_effort_mem0_sends_is_kept(self):
        llm = FakeOpenAILLM([completion(GOOD)], reasoning_effort="low", reasoning_model=True)
        service_with(FakeMemory(llm), reasoning_effort="low").add(dict(MESSAGES))
        call = llm.completions.calls[0]
        self.assertEqual(call["reasoning_effort"], "low")
        # Mem0 sends no output budget for its reasoning models; none is added.
        self.assertNotIn("max_tokens", call)

    def test_no_reasoning_effort_by_default(self):
        llm = FakeOpenAILLM([completion(GOOD)])
        service_with(FakeMemory(llm)).add(dict(MESSAGES))
        self.assertNotIn("reasoning_effort", llm.completions.calls[0])

    def test_failure_body_and_log_carry_numbers_not_text(self):
        llm = FakeOpenAILLM([completion('{"memory": [{"text": "I write release', "length", 9191, 2000, 1697)])
        service = service_with(FakeMemory(llm))
        was_disabled, sidecar.logger.disabled = sidecar.logger.disabled, False
        try:
            with self.assertLogs(sidecar.logger, level="WARNING") as logs:
                with self.assertRaises(sidecar.LLMExtractionError):
                    service.add(dict(MESSAGES))
        finally:
            sidecar.logger.disabled = was_disabled
        text = "\n".join(logs.output)
        self.assertIn("finish_reason=length, 2000/2000 output tokens (1697 reasoning)", text)
        self.assertNotIn("release", text)

    def test_length_that_mem0_still_used_is_logged(self):
        llm = FakeOpenAILLM([completion(GOOD, "length", 10, 2000, 1500)])
        service = service_with(FakeMemory(llm))
        was_disabled, sidecar.logger.disabled = sidecar.logger.disabled, False
        try:
            with self.assertLogs(sidecar.logger, level="WARNING") as logs:
                out = service.add(dict(MESSAGES))
        finally:
            sidecar.logger.disabled = was_disabled
        self.assertEqual(out["summary"]["add"], 1)
        self.assertIn("hit its output budget", "\n".join(logs.output))

    def test_clients_without_openai_shape_are_left_alone(self):
        self.assertFalse(sidecar.instrument_llm_client(SimpleNamespace(), SimpleNamespace()))
        self.assertFalse(sidecar.instrument_llm_client(None, SimpleNamespace()))

    def test_wrapping_twice_is_a_no_op(self):
        llm = FakeOpenAILLM([])
        controls = SimpleNamespace(max_tokens_override=lambda: None, reasoning_effort=None, record_stats=lambda _s: None)
        self.assertTrue(sidecar.instrument_llm_client(llm, controls))
        self.assertFalse(sidecar.instrument_llm_client(llm, controls))


class ConfigDefaultTests(unittest.TestCase):
    def build(self, llm_config):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "oss.json"
            path.write_text(json.dumps({"oss": {
                "llm": {"provider": "openai", "config": llm_config},
                "embedder": {"provider": "openai", "config": {"model": "bge-m3"}},
                "vector_store": {"provider": "qdrant", "config": {}},
            }}), encoding="utf-8")
            return sidecar.build_memory_config(str(path), "dsh_mem0_truncation_test", str(Path(tmp) / "h.db"))

    def test_default_max_tokens_when_unset(self):
        config = self.build({"model": "m"})
        self.assertEqual(config["llm"]["config"]["max_tokens"], sidecar.DEFAULT_EXTRACT_MAX_TOKENS)

    def test_explicit_max_tokens_and_reasoning_effort_win(self):
        config = self.build({"model": "m", "max_tokens": 2000, "reasoning_effort": "none"})
        self.assertEqual(config["llm"]["config"]["max_tokens"], 2000)
        self.assertEqual(config["llm"]["config"]["reasoning_effort"], "none")


class HandlerBodyTests(unittest.TestCase):
    def test_error_body_has_stats(self):
        error = sidecar.LLMExtractionError("truncated", {"finishReason": "length", "maxTokens": 2000, "completionTokens": 2000, "reasoningTokens": 1697})
        payload = sidecar.error_payload(error)
        payload.update({"code": error.code, "reason": error.reason, "retryable": error.retryable})
        payload.update(error.stats)
        self.assertEqual(payload["finishReason"], "length")
        self.assertEqual(payload["reasoningTokens"], 1697)


if __name__ == "__main__":
    unittest.main()
