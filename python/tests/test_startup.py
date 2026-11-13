"""Startup checks: Qdrant server only (issue #23), readable start failures."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mem0_sidecar as sidecar


def oss(vector_config, provider="qdrant"):
    return {
        "oss": {
            "llm": {"provider": "openai", "config": {"model": "m"}},
            "embedder": {"provider": "ollama", "config": {"model": "bge-m3", "ollama_base_url": "http://127.0.0.1:15434"}},
            "vector_store": {"provider": provider, "config": vector_config},
        }
    }


class QdrantModeTests(unittest.TestCase):
    def setUp(self):
        # test_attribution.py disables the sidecar logger module-wide.
        was_disabled, sidecar.logger.disabled = sidecar.logger.disabled, False
        self.addCleanup(setattr, sidecar.logger, "disabled", was_disabled)

    def build(self, payload):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "oss.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            return sidecar.build_memory_config(str(path), "dsh_mem0_startup_test", str(Path(tmp) / "h.db"))

    def test_path_only_is_a_config_error(self):
        with self.assertRaises(sidecar.ConfigError) as caught:
            self.build(oss({"path": "/tmp/qdrant-embedded"}))
        self.assertEqual(caught.exception.code, "QDRANT_EMBEDDED_UNSUPPORTED")
        self.assertIn("not supported", str(caught.exception))
        self.assertIn("url", str(caught.exception))
        self.assertIn(sidecar.QDRANT_DOCS_URL, str(caught.exception))

    def test_no_url_no_host_is_embedded(self):
        with self.assertRaises(sidecar.ConfigError):
            self.build(oss({}))
        # host without port: Mem0 would fall back to an embedded store
        with self.assertRaises(sidecar.ConfigError):
            self.build(oss({"host": "127.0.0.1"}))

    def test_path_and_url_uses_url_with_a_warning(self):
        with self.assertLogs("dsh-mem0-sidecar", level="WARNING") as logs:
            config = self.build(oss({"path": "/tmp/q", "url": "http://127.0.0.1:15333"}))
        self.assertEqual(config["vector_store"]["config"]["url"], "http://127.0.0.1:15333")
        self.assertTrue(any("path is ignored" in line for line in logs.output))

    def test_url_only_and_host_port_are_fine(self):
        self.build(oss({"url": "http://127.0.0.1:15333"}))
        self.build(oss({"host": "127.0.0.1", "port": 15333}))

    def test_other_vector_store_is_not_checked(self):
        self.build(oss({}, provider="chroma"))

    def test_main_reports_the_config_error_without_loading_mem0(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "oss.json"
            path.write_text(json.dumps(oss({"path": "/tmp/q"})), encoding="utf-8")
            argv = ["--config", str(path), "--collection", "c", "--user-id", "u", "--agent-id", "a",
                    "--history-db", str(Path(tmp) / "h.db"), "--token-stdin"]
            out = []
            with mock.patch.object(sidecar, "Mem0Service") as service, \
                    mock.patch("sys.stdin", new=__import__("io").StringIO("tok\n")), \
                    mock.patch("builtins.print", side_effect=lambda text, **_: out.append(text)), \
                    self.assertLogs("dsh-mem0-sidecar", level="ERROR"):
                self.assertEqual(sidecar.main(argv), 1)
            service.assert_not_called()
            payload = json.loads(out[0])
            self.assertEqual(payload["code"], "QDRANT_EMBEDDED_UNSUPPORTED")
            self.assertEqual(payload["component"], "vector_store")


class StartFailureTests(unittest.TestCase):
    def test_missing_mem0_names_the_error_type(self):
        with mock.patch("importlib.util.find_spec", return_value=None):
            with self.assertRaises(ModuleNotFoundError) as caught:
                sidecar.check_mem0_installed()
        payload = sidecar.startup_error_payload(caught.exception, None)
        self.assertEqual(payload["code"], "MEM0_NOT_INSTALLED")
        self.assertEqual(payload["type"], "ModuleNotFoundError")
        self.assertEqual(payload["error"], "ModuleNotFoundError: No module named 'mem0'")

    def test_refused_qdrant_names_host_port_and_the_windows_hint(self):
        components = sidecar.describe_components(oss({"url": "http://127.0.0.1:15333"})["oss"])
        try:
            try:
                raise ConnectionRefusedError(61, "Connection refused")
            except ConnectionRefusedError as inner:
                raise RuntimeError("[Errno 61] Connection refused") from inner
        except RuntimeError as exc:
            text = sidecar.describe_error(exc, "vector_store", components)
        self.assertTrue(text.startswith("Qdrant unreachable at 127.0.0.1:15333 (connection refused)"), text)
        self.assertIn("10013", text)

    def test_windows_refused_text_is_detected(self):
        exc = OSError("[WinError 10061] No connection could be made because the target machine actively refused it")
        self.assertTrue(sidecar.is_connection_refused(exc))
        components = sidecar.describe_components(oss({"url": "http://127.0.0.1:15333"})["oss"])
        self.assertIn("Ollama unreachable at 127.0.0.1:15434", sidecar.describe_error(exc, "embedder", components))

    def test_other_errors_keep_their_text(self):
        components = sidecar.describe_components(oss({"url": "http://127.0.0.1:15333"})["oss"])
        self.assertEqual(sidecar.describe_error(ValueError("bad dims"), "vector_store", components), "bad dims")

    def test_startup_payload_for_a_refused_qdrant(self):
        config = oss({"url": "http://127.0.0.1:15333"})["oss"]
        exc = ConnectionRefusedError(61, "Connection refused")
        exc._dsh_component = "vector_store"
        payload = sidecar.startup_error_payload(exc, config)
        self.assertEqual(payload["component"], "vector_store")
        self.assertEqual(payload["endpoint"], "127.0.0.1:15333")
        self.assertIn("Qdrant unreachable at 127.0.0.1:15333", payload["error"])
        self.assertEqual(payload["code"], "START_FAILED")


if __name__ == "__main__":
    unittest.main()
