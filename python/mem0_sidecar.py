#!/usr/bin/env python3
"""Local Mem0 OSS sidecar for the DSH Mem0 plugin.

The sidecar is deliberately narrow: it speaks simple JSON over loopback and is
started by Node with a random port and a random bearer token. The token is
read from the first line of stdin so it never appears on the command line. It reuses a local
Mem0 OSS provider configuration (LLM, embedder, Qdrant endpoint) but writes a
DSH-only Qdrant collection so other Mem0 clients can keep their own collections
separate.

Nothing in this file returns or logs API keys. The HTTP surface is only bound to
127.0.0.1 and requires the per-process token on every request.
"""

from __future__ import annotations

import argparse
import hmac
import importlib.metadata
import json
import logging
import os
import re
import signal
import sys
import threading
import time
import traceback
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger("dsh-mem0-sidecar")
MAX_BODY_BYTES = 4 * 1024 * 1024
PROBE_TEXT = "dsh-mem0 health probe"


def _json_default(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if isinstance(value, Path):
        return str(value)
    return str(value)


def _jsonable(value: Any) -> Any:
    """Turn pydantic models / nested values into lossless-ish JSON values."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "model_dump"):
        return _jsonable(value.model_dump())
    return str(value)


def _normalise_memory(item: Any) -> dict[str, Any]:
    if hasattr(item, "model_dump"):
        item = item.model_dump()
    if not isinstance(item, dict):
        return {"memory": str(item)}
    return _jsonable(item)


def _normalise_results(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        rows = value.get("results", [])
    elif isinstance(value, list):
        rows = value
    else:
        rows = []
    return [_normalise_memory(row) for row in rows]


def _history_paths(history_db: str) -> tuple[str, str]:
    path = Path(os.path.expanduser(history_db))
    path.parent.mkdir(parents=True, exist_ok=True)
    stem = path.stem
    suffix = path.suffix or ".db"
    return (
        str(path.with_name(f"{stem}-read{suffix}")),
        str(path.with_name(f"{stem}-write{suffix}")),
    )


def build_memory_config(config_path: str, collection: str, history_db: str) -> dict[str, Any]:
    """Read a Mem0 OSS config and override only DSH-owned fields."""
    path = Path(os.path.expanduser(config_path))
    if not path.is_file():
        raise ValueError(f"Mem0 config file not found: {path}")
    raw = json.loads(path.read_text(encoding="utf-8"))
    oss = raw.get("oss")
    if not isinstance(oss, dict):
        raise ValueError("Mem0 config has no 'oss' block; OSS backend requires a Mem0 OSS config file")

    for section in ("llm", "embedder", "vector_store"):
        block = oss.get(section)
        if not isinstance(block, dict):
            raise ValueError(f"Mem0 config is missing oss.{section}")
        if not isinstance(block.get("config"), dict):
            raise ValueError(f"Mem0 config is missing oss.{section}.config")

    vector_store = deepcopy(oss["vector_store"])
    vector_config = vector_store.setdefault("config", {})
    vector_config["collection_name"] = collection
    if not vector_config.get("embedding_model_dims"):
        embedder_model = str(oss["embedder"].get("config", {}).get("model", ""))
        if "bge-m3" in embedder_model.lower():
            vector_config["embedding_model_dims"] = 1024

    read_history, write_history = _history_paths(history_db)
    # The first two entries are the same base config; Mem0Service clones this
    # per instance with a distinct SQLite history file.
    return {
        "llm": deepcopy(oss["llm"]),
        "embedder": deepcopy(oss["embedder"]),
        "vector_store": vector_store,
        "history_db_path": read_history,
        "version": raw.get("version") or "v1.1",
        "_write_history_db_path": write_history,
    }


# --- failure attribution --------------------------------------------------
#
# A Mem0 call crosses three components: the embedder (e.g. local Ollama), the
# LLM that extracts facts (e.g. an OpenAI-compatible cloud endpoint) and the
# vector store (e.g. local Qdrant). Mem0Service wraps their methods so an
# exception is tagged with the component and step that raised it, and
# StepTracker keeps the steps still running so Node can say which one was
# slow when its own request timeout fires (GET /steps).

COMPONENT_STEPS = {
    "embedder": {"embed": "embed", "embed_batch": "embed"},
    "llm": {"generate_response": "llm_extract"},
    "vector_store": {
        "search": "search",
        "keyword_search": "search",
        "list": "search",
        "get": "search",
        "col_info": "search",
        "list_cols": "search",
        "insert": "store",
        "update": "store",
        "delete": "store",
        "reset": "store",
        "create_col": "store",
        "delete_col": "store",
    },
}

# Innermost frame wins: mem0/<package>/ or a client library module.
_FRAME_HINTS = (
    ("/mem0/embeddings/", "embedder", "embed"),
    ("/mem0/llms/", "llm", "llm_extract"),
    ("/mem0/vector_stores/", "vector_store", None),
    ("/qdrant_client/", "vector_store", None),
    ("/ollama/", None, None),  # Ollama serves embeddings or an LLM; decided by the mem0 frame
    ("/openai/", "llm", "llm_extract"),
)

_SECRET_PATTERNS = (
    (re.compile(r"\b(?:sk-|m0sk_|mem0_sk_|psk-)[A-Za-z0-9_-]{8,}"), "[REDACTED]"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)((?:api[_-]?key|token|secret|password)\s*[:=]\s*)['\"]?[^\s'\",}]+"), r"\1[REDACTED]"),
    (re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+(@)", re.I), r"\1[REDACTED]\2"),
)


def redact_error(text: Any, limit: int = 500) -> str:
    """Strip credential shapes and home-directory paths from an error text."""
    value = str(text)
    home = os.path.expanduser("~")
    if home and home not in ("/", "~"):
        value = value.replace(home, "~")
    value = re.sub(r"/(?:Users|home)/[^/\s'\":]+", "~", value)
    for pattern, replacement in _SECRET_PATTERNS:
        value = pattern.sub(replacement, value)
    value = " ".join(value.split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _endpoint_of(block: Any) -> str | None:
    """host:port of a provider config block, without scheme, path or credentials."""
    if not isinstance(block, dict):
        return None
    config = block.get("config") if isinstance(block.get("config"), dict) else {}
    for key in ("ollama_base_url", "openai_base_url", "base_url", "url", "api_base", "lmstudio_base_url", "vllm_base_url"):
        value = config.get(key)
        if isinstance(value, str) and value:
            parsed = urlparse(value if "://" in value else f"http://{value}")
            if parsed.hostname:
                return f"{parsed.hostname}:{parsed.port}" if parsed.port else parsed.hostname
    host = config.get("host")
    if isinstance(host, str) and host:
        port = config.get("port")
        return f"{host}:{port}" if port else host
    if isinstance(config.get("path"), str):
        return "local path"
    return None


def describe_components(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Provider name and endpoint per component, for error payloads."""
    out: dict[str, dict[str, Any]] = {}
    for component, section in (("llm", "llm"), ("embedder", "embedder"), ("vector_store", "vector_store")):
        block = config.get(section)
        if isinstance(block, dict):
            out[component] = {"provider": str(block.get("provider") or "unknown"), "endpoint": _endpoint_of(block)}
    return out


def attribute_exception(exc: BaseException) -> dict[str, str]:
    """Component and step for an exception: the wrapper's tag, else the traceback."""
    current: BaseException | None = exc
    for _ in range(5):
        if current is None:
            break
        component = getattr(current, "_dsh_component", None)
        if component:
            result = {"component": component}
            step = getattr(current, "_dsh_step", None)
            if step:
                result["step"] = step
            return result
        current = current.__cause__ or current.__context__
    found: dict[str, str] = {}
    tb = exc.__traceback__
    while tb is not None:
        filename = tb.tb_frame.f_code.co_filename.replace("\\", "/")
        for marker, component, step in _FRAME_HINTS:
            if marker in filename and component:
                found = {"component": component}
                if step:
                    found["step"] = step
        tb = tb.tb_next
    return found


class StepTracker:
    """Component steps currently running, for GET /steps."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active: dict[int, dict[str, Any]] = {}
        self._next = 0

    def start(self, component: str, step: str) -> int:
        with self._lock:
            self._next += 1
            self._active[self._next] = {"component": component, "step": step, "started": time.monotonic()}
            return self._next

    def finish(self, token: int) -> None:
        with self._lock:
            self._active.pop(token, None)

    def snapshot(self) -> list[dict[str, Any]]:
        now = time.monotonic()
        with self._lock:
            rows = [
                {"component": row["component"], "step": row["step"], "elapsedMs": int((now - row["started"]) * 1000)}
                for row in self._active.values()
            ]
        return sorted(rows, key=lambda row: -row["elapsedMs"])


def instrument_component(target: Any, component: str, tracker: StepTracker) -> None:
    """Wrap a component's known methods on this instance (not its class)."""
    if target is None:
        return
    for method_name, step in COMPONENT_STEPS[component].items():
        original = getattr(target, method_name, None)
        if not callable(original) or getattr(original, "_dsh_wrapped", False):
            continue

        def wrapper(*args: Any, __original=original, __step=step, **kwargs: Any) -> Any:
            token = tracker.start(component, __step)
            try:
                return __original(*args, **kwargs)
            except BaseException as exc:
                if getattr(exc, "_dsh_component", None) is None:
                    try:
                        exc._dsh_component = component  # type: ignore[attr-defined]
                        exc._dsh_step = __step  # type: ignore[attr-defined]
                    except Exception:  # noqa: BLE001 - some exception types refuse attributes
                        pass
                raise
            finally:
                tracker.finish(token)

        wrapper._dsh_wrapped = True  # type: ignore[attr-defined]
        try:
            setattr(target, method_name, wrapper)
        except Exception:  # noqa: BLE001 - a frozen object stays unwrapped
            pass


def instrument_memory(memory: Any, tracker: StepTracker) -> None:
    instrument_component(getattr(memory, "embedding_model", None), "embedder", tracker)
    instrument_component(getattr(memory, "llm", None), "llm", tracker)
    instrument_component(getattr(memory, "vector_store", None), "vector_store", tracker)


def error_payload(exc: BaseException, components: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """Redacted error body for a failed request, with the failing component."""
    payload: dict[str, Any] = {"error": redact_error(exc)}
    payload.update(attribute_exception(exc))
    details = (components or {}).get(payload.get("component", ""))
    if details:
        payload["provider"] = details.get("provider")
        if details.get("endpoint"):
            payload["endpoint"] = details["endpoint"]
    return payload


class Mem0Service:
    """Two Memory instances over one collection: read and write paths."""

    def __init__(self, config: dict[str, Any], collection: str, user_id: str, agent_id: str):
        # Do this before importing mem0 so its telemetry module observes it.
        os.environ["MEM0_TELEMETRY"] = "false"
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
        # OpenAILLM switches to OpenRouter whenever this variable exists, even
        # when the config points at another OpenAI-compatible endpoint.
        os.environ.pop("OPENROUTER_API_KEY", None)

        from mem0.memory.main import Memory

        self.collection = collection
        self.user_id = user_id
        self.agent_id = agent_id
        self._read_lock = threading.RLock()
        self._write_lock = threading.RLock()

        read_config = {k: v for k, v in config.items() if not k.startswith("_")}
        write_config = deepcopy(read_config)
        write_config["history_db_path"] = config["_write_history_db_path"]
        # SQLiteManager expects a filename; both paths are distinct files.
        self.read_memory = Memory.from_config(read_config)
        self.write_memory = Memory.from_config(write_config)
        self.steps = StepTracker()
        self.components = describe_components(read_config)
        instrument_memory(self.read_memory, self.steps)
        instrument_memory(self.write_memory, self.steps)

    @staticmethod
    def _version() -> str:
        try:
            return importlib.metadata.version("mem0ai")
        except Exception:
            try:
                import mem0

                return getattr(mem0, "__version__", "unknown")
            except Exception:
                return "unknown"

    def health(self) -> dict[str, Any]:
        read_result = None
        read_error = None
        try:
            with self._read_lock:
                read_result = self.read_memory.get_all(
                    filters={"user_id": self.user_id}, top_k=1
                )
        except Exception as exc:  # noqa: BLE001 - status must report, not crash
            read_error = str(exc)

        embed_ok = False
        embed_dims = None
        embed_error = None
        try:
            vector = self.read_memory.embedding_model.embed(PROBE_TEXT, "search")
            embed_ok = True
            embed_dims = len(vector)
        except Exception as exc:  # noqa: BLE001
            embed_error = str(exc)

        memory_count = len(read_result.get("results", [])) if isinstance(read_result, dict) else 0
        return {
            "ok": read_error is None,
            "backend": "oss",
            "pid": os.getpid(),
            "collection": self.collection,
            "userId": self.user_id,
            "agentId": self.agent_id,
            "pythonVersion": sys.version.split()[0],
            "mem0Version": self._version(),
            "memoryCount": memory_count,
            "qdrant": {"ok": read_error is None, "error": read_error},
            "embedder": {"ok": embed_ok, "dimensions": embed_dims, "error": embed_error},
        }

    def search(self, query: str, filters: dict[str, Any], top_k: int | None, threshold: float | None) -> list[dict[str, Any]]:
        kwargs: dict[str, Any] = {"filters": filters}
        if top_k is not None:
            kwargs["top_k"] = top_k
        if threshold is not None:
            kwargs["threshold"] = threshold
        with self._read_lock:
            result = self.read_memory.search(query, **kwargs)
        return _normalise_results(result)

    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        messages = payload.get("messages")
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        if not isinstance(messages, list) or not messages:
            raise ValueError("messages must be a non-empty list or string")
        for message in messages:
            if not isinstance(message, dict) or not isinstance(message.get("content"), str):
                raise ValueError("each message must be an object with a string content field")
            if message.get("role") not in ("user", "assistant", "system"):
                raise ValueError("each message role must be user, assistant or system")
        kwargs: dict[str, Any] = {
            "user_id": payload.get("user_id") or self.user_id,
            "agent_id": payload.get("agent_id") or self.agent_id,
            "infer": payload.get("infer") is not False,
        }
        if payload.get("run_id"):
            kwargs["run_id"] = payload["run_id"]
        if isinstance(payload.get("metadata"), dict):
            kwargs["metadata"] = payload["metadata"]
        with self._write_lock:
            result = self.write_memory.add(messages, **kwargs)
        if isinstance(result, dict):
            return {"results": _normalise_results(result)}
        return {"results": _normalise_results(result)}

    def list(self, filters: dict[str, Any], top_k: int | None) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"filters": filters}
        if top_k is not None:
            kwargs["top_k"] = top_k
        with self._read_lock:
            result = self.read_memory.get_all(**kwargs)
        return {"results": _normalise_results(result)}

    def get(self, memory_id: str) -> dict[str, Any] | None:
        with self._read_lock:
            result = self.read_memory.get(memory_id)
        return _normalise_memory(result) if result is not None else None

    def update(self, memory_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        if "text" in payload:
            kwargs["data"] = payload["text"]
        if "metadata" in payload:
            kwargs["metadata"] = payload["metadata"]
        if "expiration_date" in payload:
            kwargs["expiration_date"] = payload["expiration_date"]
        if not kwargs:
            raise ValueError("update requires at least one of text, metadata, expiration_date")
        with self._write_lock:
            result = self.write_memory.update(memory_id, **kwargs)
        return _jsonable(result) if isinstance(result, dict) else {"message": str(result)}

    def delete(self, memory_id: str) -> dict[str, Any]:
        with self._write_lock:
            result = self.write_memory.delete(memory_id)
        return _jsonable(result) if isinstance(result, dict) else {"message": str(result)}


class SidecarHandler(BaseHTTPRequestHandler):
    server_version = "DSHMem0Sidecar/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        logger.debug(fmt, *args)

    @property
    def service(self) -> Mem0Service:
        return self.server.service  # type: ignore[attr-defined]

    @property
    def token(self) -> str:
        return self.server.token  # type: ignore[attr-defined]

    def _send(self, status: int, payload: Any) -> None:
        data = json.dumps(_jsonable(payload), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self) -> bool:
        supplied = self.headers.get("x-dsh-mem0-token", "")
        return bool(supplied) and hmac.compare_digest(str(supplied), self.token)

    def _read_json(self) -> dict[str, Any]:
        raw_length = self.headers.get("content-length", "0")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise ValueError("invalid content-length") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError("request body is too large")
        self._body_read = True
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("request body must be JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("request body must be a JSON object")
        return value

    def _path(self) -> tuple[str, dict[str, list[str]]]:
        parsed = urlparse(self.path)
        return parsed.path, parse_qs(parsed.query)

    def _send_and_close(self, status: int, payload: Any) -> None:
        # The request body was not read; on a keep-alive connection its bytes
        # would be parsed as the next request, so end the connection instead.
        self.close_connection = True
        self.send_response(status)
        data = json.dumps(_jsonable(payload), ensure_ascii=False).encode("utf-8")
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, method: str) -> None:
        self._body_read = False
        if not self._authorised():
            self._send_and_close(401, {"error": "unauthorized"})
            return
        path, query = self._path()
        try:
            if method == "GET" and path == "/health":
                self._send(200, self.service.health())
                return
            if method == "GET" and path == "/steps":
                steps = getattr(self.service, "steps", None)
                self._send(200, {
                    "steps": steps.snapshot() if steps else [],
                    "components": getattr(self.service, "components", {}),
                })
                return
            if method == "POST" and path == "/search":
                body = self._read_json()
                search_query = body.get("query")
                if not isinstance(search_query, str) or not search_query.strip():
                    raise ValueError("query is required")
                filters = body.get("filters")
                if not isinstance(filters, dict):
                    filters = {"user_id": self.service.user_id}
                top_k = body.get("top_k")
                threshold = body.get("threshold")
                self._send(200, {"results": self.service.search(search_query, filters, top_k, threshold)})
                return
            if method == "POST" and path == "/add":
                self._send(200, self.service.add(self._read_json()))
                return
            if method == "GET" and path == "/memories":
                filters: dict[str, Any] = {}
                for key in ("user_id", "agent_id", "run_id"):
                    if key in query and query[key]:
                        filters[key] = query[key][0]
                if not any(filters.values()):
                    filters = {"user_id": self.service.user_id}
                top_k = int(query["top_k"][0]) if "top_k" in query and query["top_k"] else None
                self._send(200, self.service.list(filters, top_k))
                return
            if path.startswith("/memories/"):
                memory_id = path[len("/memories/") :]
                if not memory_id or "/" in memory_id:
                    self._reply_error(404, {"error": "memory not found"})
                    return
                if method == "GET":
                    memory = self.service.get(memory_id)
                    if memory is None:
                        self._reply_error(404, {"error": "memory not found"})
                    else:
                        self._send(200, memory)
                    return
                if method == "PUT":
                    self._send(200, self.service.update(memory_id, self._read_json()))
                    return
                if method == "DELETE":
                    self._send(200, self.service.delete(memory_id))
                    return
            self._reply_error(404, {"error": "not found"})
        except ValueError as exc:
            # Our own validation errors are plain 400/404; a ValueError raised
            # inside a component (e.g. a missing Qdrant collection) is a 500
            # with attribution.
            attribution = attribute_exception(exc)
            if not attribution:
                status = 404 if "not found" in str(exc).lower() else 400
                self._reply_error(status, {"error": redact_error(exc)})
            else:
                logger.error("request failed: %s", traceback.format_exc())
                self._reply_error(500, error_payload(exc, getattr(self.service, "components", None)))
        except Exception as exc:  # noqa: BLE001 - one request must not kill the server
            logger.error("request failed: %s", traceback.format_exc())
            self._reply_error(500, error_payload(exc, getattr(self.service, "components", None)))

    def _reply_error(self, status: int, payload: Any) -> None:
        declared = self.headers.get("content-length", "0").strip()
        if not self._body_read and declared not in ("", "0"):
            self._send_and_close(status, payload)
        else:
            self._send(status, payload)

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")


class DshMem0Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, service: Mem0Service, token: str):
        super().__init__(address, handler)
        self.service = service
        self.token = token


def read_token(stream: Any) -> str:
    """Read the per-process bearer token Node writes to stdin."""
    token = (stream.readline() or "").strip()
    if not token:
        raise ValueError("no sidecar token on stdin")
    return token


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="DSH Mem0 OSS sidecar")
    parser.add_argument("--config", required=True)
    parser.add_argument("--collection", required=True)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--history-db", required=True)
    parser.add_argument(
        "--token-stdin",
        action="store_true",
        help="read the bearer token from the first line of stdin (the only supported way)",
    )
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    try:
        token = read_token(sys.stdin)
        config = build_memory_config(args.config, args.collection, args.history_db)
        service = Mem0Service(config, args.collection, args.user_id, args.agent_id)
        server = DshMem0Server(("127.0.0.1", args.port), SidecarHandler, service, token)

        def stop(_signum, _frame):
            threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        print(json.dumps({"port": server.server_port, "pid": os.getpid()}), flush=True)
        server.serve_forever()
        server.server_close()
        return 0
    except Exception as exc:  # noqa: BLE001 - surface a clean startup failure to Node
        print(json.dumps({"error": str(exc), "code": "START_FAILED"}), flush=True)
        logger.error("sidecar failed to start: %s", traceback.format_exc())
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
