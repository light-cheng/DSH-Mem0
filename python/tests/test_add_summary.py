"""/add outcome: facts extracted and ADD/UPDATE/DELETE/NONE counts.

No mem0ai install needed: a fake Memory calls its LLM the way Mem0 does.
"""
import sys
import threading
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mem0_sidecar as sidecar


class FakeLLM:
    def __init__(self, answers):
        self.answers = list(answers)

    def generate_response(self, messages=None, **_kwargs):
        return self.answers.pop(0)


class FakeMemory:
    """Calls the LLM once per answer queued, then returns `results`."""

    def __init__(self, answers, results):
        self.llm = FakeLLM(answers)
        self.calls = len(answers)
        self.results = results

    def add(self, messages, **_kwargs):
        for _ in range(self.calls):
            self.llm.generate_response(messages=[])
        return {"results": self.results}


def service_with(memory):
    service = sidecar.Mem0Service.__new__(sidecar.Mem0Service)
    service.user_id = "dsh-test-user"
    service.agent_id = "dsh"
    service._write_lock = threading.RLock()
    service.write_memory = memory
    service._llm_responses = None
    sidecar.record_llm_responses(memory.llm, service._record_llm_response)
    return service


MESSAGES = {"messages": [{"role": "user", "content": "I write release notes in English and Chinese"}], "infer": True}


FENCED = '```json\n{"memory": [{"text": "a"}]}\n```'
THINK = '<think>The user wrote {"tea": true}; maybe {x}.</think>\n{"memory": [{"text": "a"}]}'
AROUND = 'Here is the result:\n{"memory": [{"text": "a"}]}\nHope this helps.'
FENCE_MID = 'Sure:\n```json\n{"memory": [{"text": "a"}]}\n```\nDone.'
TRUNCATED = '{"memory": [{"text": "a"}, {"text": "b'
REFUSAL = "I'm sorry, but I can't help with that request."


class ParseExtractionTests(unittest.TestCase):
    def test_new_and_old_shapes(self):
        self.assertEqual(len(sidecar.parse_extraction('{"memory": [{"text": "a"}, {"text": "b"}]}')), 2)
        self.assertEqual(sidecar.parse_extraction('{"facts": ["a"]}'), ["a"])
        self.assertEqual(sidecar.parse_extraction('```json\n{"memory": []}\n```'), [])

    def test_answers_mem0_can_use(self):
        for answer in (FENCED, THINK, AROUND, FENCE_MID, '<think>{a}</think>\n' + FENCED):
            with self.subTest(answer=answer):
                self.assertEqual(sidecar.inspect_extraction(answer), ([{"text": "a"}], None))

    def test_failure_reasons(self):
        for answer, reason in (
            ("", "empty"),
            (None, "empty"),
            ("  \n", "empty"),
            ("<think>nothing</think>", "empty"),
            (TRUNCATED, "truncated"),
            ('{"memory": [{"te', "truncated"),
            (REFUSAL, "refusal"),
            ("抱歉，我无法帮助完成这个请求。", "refusal"),
            ("The user likes tea.", "not_json"),
            ("{not json}", "not_json"),
            ("[1, 2]", "not_json"),
        ):
            with self.subTest(answer=answer):
                facts, got = sidecar.inspect_extraction(answer)
                self.assertEqual(got, reason)
                self.assertIsNone(facts) if reason != "empty" else self.assertEqual(facts, [])

    def test_fallback_copies_match_mem0(self):
        try:
            from mem0.memory.utils import extract_json, remove_code_blocks
        except Exception:  # noqa: BLE001 - mem0ai not installed (CI)
            self.skipTest("mem0ai not installed")
        for text in (FENCED, THINK, AROUND, FENCE_MID, TRUNCATED, REFUSAL, "", "  ", ["x", {"text": "y"}], None):
            self.assertEqual(sidecar._remove_code_blocks(text), remove_code_blocks(text))
            if isinstance(text, str):
                self.assertEqual(sidecar._extract_json(text), extract_json(text))

    def test_describe_answer_never_contains_the_text(self):
        line = sidecar.describe_answer("I write release notes in English and Chinese")
        self.assertEqual(line, "44 chars, starts with text")
        self.assertEqual(sidecar.describe_answer(THINK)[-15:], "<think> section")


class AddSummaryTests(unittest.TestCase):
    def test_new_facts_are_added(self):
        memory = FakeMemory(['{"memory": [{"text": "a"}, {"text": "b"}]}'], [
            {"id": "1", "memory": "a", "event": "ADD"},
            {"id": "2", "memory": "b", "event": "ADD"},
        ])
        out = service_with(memory).add(dict(MESSAGES))
        self.assertEqual(out["summary"], {"facts": 2, "add": 2, "update": 0, "delete": 0, "none": 0})

    def test_known_facts_count_as_none(self):
        # Mem0 2.2 drops an exact duplicate (hash match) and returns nothing.
        memory = FakeMemory(['{"memory": [{"text": "a"}]}'], [])
        out = service_with(memory).add(dict(MESSAGES))
        self.assertEqual(out["results"], [])
        self.assertEqual(out["summary"], {"facts": 1, "add": 0, "update": 0, "delete": 0, "none": 1})

    def test_nothing_extracted(self):
        memory = FakeMemory(['{"memory": []}'], [])
        out = service_with(memory).add(dict(MESSAGES))
        self.assertEqual(out["summary"]["facts"], 0)
        self.assertEqual(out["summary"]["none"], 0)

    def test_older_pipeline_counts_none_from_the_update_answer(self):
        memory = FakeMemory(
            [
                '{"facts": ["a", "b", "c"]}',
                '{"memory": [{"id": "0", "text": "a", "event": "NONE"}, {"id": "1", "text": "b2", "event": "UPDATE"}, {"id": "2", "text": "c", "event": "ADD"}]}',
            ],
            [{"id": "x", "memory": "b2", "event": "UPDATE"}, {"id": "y", "memory": "c", "event": "ADD"}],
        )
        out = service_with(memory).add(dict(MESSAGES))
        self.assertEqual(out["summary"], {"facts": 3, "add": 1, "update": 1, "delete": 0, "none": 1})

    def test_mem0_stored_but_our_parse_failed_is_not_an_error(self):
        # Regression (PR #19): Mem0 stored a memory, the display summary could
        # not parse the answer, and /add returned 500 "nothing was stored".
        memory = FakeMemory(["@@ not something we can parse @@"], [{"id": "1", "memory": "a", "event": "ADD"}])
        out = service_with(memory).add(dict(MESSAGES))
        self.assertEqual(len(out["results"]), 1)
        self.assertEqual(out["summary"], {"add": 1, "update": 0, "delete": 0})

    def test_summary_never_raises(self):
        with mock.patch.object(sidecar, "inspect_extraction", side_effect=RuntimeError("boom")):
            self.assertEqual(sidecar.summarize_add([{"event": "ADD"}], ["x"]), {"add": 1, "update": 0, "delete": 0})

    def test_every_answer_format(self):
        stored = [{"id": "1", "memory": "a", "event": "ADD"}]
        for answer in (FENCED, THINK, AROUND, FENCE_MID):
            with self.subTest(answer=answer):
                out = service_with(FakeMemory([answer], stored)).add(dict(MESSAGES))
                self.assertEqual(out["summary"], {"facts": 1, "add": 1, "update": 0, "delete": 0, "none": 0})
        for answer, reason, retryable in (
            ("", "empty", True),
            (TRUNCATED, "truncated", True),
            ("The user likes tea.", "not_json", True),
            (REFUSAL, "refusal", False),
        ):
            with self.subTest(answer=answer):
                service = service_with(FakeMemory([answer], []))
                with self.assertRaises(sidecar.LLMExtractionError) as caught:
                    service.add(dict(MESSAGES))
                self.assertEqual(caught.exception.reason, reason)
                self.assertEqual(caught.exception.retryable, retryable)
                self.assertEqual(sidecar.attribute_exception(caught.exception), {"component": "llm", "step": "llm_extract"})
                self.assertIn("nothing was stored", str(caught.exception))
                # The memory text never reaches the error, and the recorder
                # is reset after a failure.
                self.assertNotIn("release notes", str(caught.exception))
                self.assertIsNone(service._llm_responses)

    def test_unusable_answer_with_stored_results_is_not_an_error(self):
        # Never seen with Mem0 2.2 (no facts → nothing stored), but whatever
        # Mem0 stored wins over our reading of the answer.
        out = service_with(FakeMemory([REFUSAL], [{"id": "1", "memory": "a", "event": "ADD"}])).add(dict(MESSAGES))
        self.assertEqual(out["summary"], {"add": 1, "update": 0, "delete": 0})

    def test_failure_log_has_shape_not_text(self):
        service = service_with(FakeMemory(["I write release notes in English and Chinese"], []))
        was_disabled, sidecar.logger.disabled = sidecar.logger.disabled, False
        try:
            with self.assertLogs(sidecar.logger, level="WARNING") as logs:
                with self.assertRaises(sidecar.LLMExtractionError):
                    service.add(dict(MESSAGES))
        finally:
            sidecar.logger.disabled = was_disabled
        text = "\n".join(logs.output)
        self.assertIn("not_json", text)
        self.assertIn("44 chars, starts with text", text)
        self.assertNotIn("release notes", text)

    def test_infer_false_has_no_summary(self):
        memory = FakeMemory([], [{"id": "1", "memory": "a", "event": "ADD"}])
        out = service_with(memory).add({**MESSAGES, "infer": False})
        self.assertNotIn("summary", out)

    def test_llm_calls_outside_add_are_not_recorded(self):
        memory = FakeMemory(['{"memory": []}'], [])
        service = service_with(memory)
        memory.llm.answers.append("stray")
        memory.llm.generate_response(messages=[])
        self.assertIsNone(service._llm_responses)


if __name__ == "__main__":
    unittest.main()
