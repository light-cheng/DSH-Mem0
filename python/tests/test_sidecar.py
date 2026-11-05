import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mem0_sidecar as sidecar


class BuildConfigTests(unittest.TestCase):
    def write_config(self, payload):
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name) / "mem0.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        self.addCleanup(directory.cleanup)
        return path

    def test_overrides_only_dsh_owned_fields(self):
        path = self.write_config(
            {
                "oss": {
                    "llm": {
                        "provider": "openai",
                        "config": {"model": "model-a", "api_key": "llm-secret"},
                    },
                    "embedder": {
                        "provider": "openai",
                        "config": {"model": "bge-m3-local", "api_key": "embed-secret"},
                    },
                    "vector_store": {
                        "provider": "qdrant",
                        "config": {"url": "http://127.0.0.1:6333", "embedding_model_dims": 1024},
                    },
                }
            }
        )
        config = sidecar.build_memory_config(str(path), "dsh_mem0", "/tmp/dsh-history.db")
        self.assertEqual(config["vector_store"]["config"]["collection_name"], "dsh_mem0")
        self.assertEqual(config["vector_store"]["config"]["embedding_model_dims"], 1024)
        self.assertEqual(config["llm"]["config"]["model"], "model-a")
        self.assertEqual(config["embedder"]["config"]["model"], "bge-m3-local")
        self.assertTrue(config["history_db_path"].endswith("dsh-history-read.db"))
        self.assertTrue(config["_write_history_db_path"].endswith("dsh-history-write.db"))
        # The sidecar needs the credentials to call the local providers, but
        # health responses must never expose them; that contract is covered by
        # the handler tests and the Node status test.
        self.assertEqual(config["llm"]["config"]["api_key"], "llm-secret")

    def test_rejects_missing_oss_block(self):
        path = self.write_config({"mode": "oss"})
        with self.assertRaisesRegex(ValueError, "oss"):
            sidecar.build_memory_config(str(path), "dsh_mem0", "/tmp/history.db")

    def test_history_paths_are_sibling_files(self):
        read_path, write_path = sidecar._history_paths("/tmp/dsh/history.db")
        self.assertEqual(read_path, "/tmp/dsh/history-read.db")
        self.assertEqual(write_path, "/tmp/dsh/history-write.db")


class JsonHelpersTests(unittest.TestCase):
    def test_normalises_memory_results(self):
        self.assertEqual(
            sidecar._normalise_results({"results": [{"id": "m1", "memory": "x"}]}),
            [{"id": "m1", "memory": "x"}],
        )
        self.assertEqual(sidecar._normalise_results(None), [])


class TokenTests(unittest.TestCase):
    def test_reads_token_from_first_stdin_line(self):
        import io

        self.assertEqual(sidecar.read_token(io.StringIO("abc-123\nignored\n")), "abc-123")

    def test_rejects_missing_token(self):
        import io

        with self.assertRaisesRegex(ValueError, "token"):
            sidecar.read_token(io.StringIO(""))

    def test_token_is_not_a_command_line_option(self):
        with self.assertRaises(SystemExit):
            sidecar.main(["--config", "x", "--collection", "c", "--user-id", "u", "--agent-id", "a",
                          "--history-db", "h", "--token", "secret"])


if __name__ == "__main__":
    unittest.main()
