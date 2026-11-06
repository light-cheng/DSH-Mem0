"""/add outcome: facts extracted and ADD/UPDATE/DELETE/NONE counts.

No mem0ai install needed: a fake Memory calls its LLM the way Mem0 does.
"""
import sys
import threading
import unittest
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


class ParseExtractionTests(unittest.TestCase):
    def test_new_and_old_shapes(self):
        self.assertEqual(len(sidecar.parse_extraction('{"memory": [{"text": "a"}, {"text": "b"}]}')), 2)
        self.assertEqual(sidecar.parse_extraction('{"facts": ["a"]}'), ["a"])
        self.assertEqual(sidecar.parse_extraction('```json\n{"memory": []}\n```'), [])
        self.assertEqual(len(sidecar.parse_extraction('Sure! {"memory": [{"text": "a"}]} done')), 1)

    def test_empty_and_unparseable(self):
        self.assertEqual(sidecar.parse_extraction(""), [])
        self.assertEqual(sidecar.parse_extraction(None), [])
        self.assertIsNone(sidecar.parse_extraction("I cannot help with that"))
        self.assertIsNone(sidecar.parse_extraction("{not json}"))


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

    def test_unparseable_extraction_is_an_llm_failure(self):
        memory = FakeMemory(["Sorry, I can't do that."], [])
        service = service_with(memory)
        with self.assertRaises(sidecar.ExtractionParseError) as caught:
            service.add(dict(MESSAGES))
        self.assertEqual(sidecar.attribute_exception(caught.exception), {"component": "llm", "step": "llm_extract"})
        # The memory text never reaches the error.
        self.assertNotIn("release notes", str(caught.exception))
        # The recorder is reset after a failure.
        self.assertIsNone(service._llm_responses)

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
