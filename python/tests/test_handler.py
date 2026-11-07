"""SidecarHandler tests with a fake Mem0 service and an in-memory socket.

No mem0ai install and no listening port are needed, so these run in CI and
in sandboxes that forbid binding.
"""
import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mem0_sidecar as sidecar

TOKEN = "test-token"


def setUpModule():
    # The handler logs tracebacks for 500s; keep test output clean.
    sidecar.logger.disabled = True


class FakeService:
    user_id = "dsh-test-user"

    def __init__(self):
        self.calls = []

    def health(self):
        self.calls.append(("health",))
        return {"ok": True}

    def search(self, query, filters, top_k, threshold):
        self.calls.append(("search", query, filters, top_k, threshold))
        return [{"id": "m1", "memory": "likes tea"}]

    def add(self, payload):
        self.calls.append(("add", payload))
        return {"results": []}

    def list(self, filters, top_k):
        self.calls.append(("list", filters, top_k))
        return {"results": []}

    def get(self, memory_id):
        self.calls.append(("get", memory_id))
        return {"id": memory_id} if memory_id == "m1" else None

    def update(self, memory_id, payload):
        self.calls.append(("update", memory_id, payload))
        return {"message": "updated"}

    def delete(self, memory_id):
        self.calls.append(("delete", memory_id))
        return {"message": "deleted"}


class FakeConnection:
    def __init__(self, data: bytes):
        self._in = io.BytesIO(data)
        self.out = bytearray()

    def makefile(self, mode, *args, **kwargs):
        return self._in

    def sendall(self, data):
        self.out.extend(data)

    def settimeout(self, _value):
        pass


class FakeServer:
    def __init__(self, service):
        self.service = service
        self.token = TOKEN


def request(service, method, path, body=None, token=TOKEN, headers=None):
    payload = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    lines = [f"{method} {path} HTTP/1.1", "Host: 127.0.0.1"]
    if token is not None:
        lines.append(f"x-dsh-mem0-token: {token}")
    all_headers = {"content-length": str(len(payload))}
    all_headers.update(headers or {})
    lines += [f"{k}: {v}" for k, v in all_headers.items()]
    raw = ("\r\n".join(lines) + "\r\n\r\n").encode() + payload
    connection = FakeConnection(raw)
    sidecar.SidecarHandler(connection, ("127.0.0.1", 0), FakeServer(service))
    responses = parse_responses(bytes(connection.out))
    # One request in, exactly one response out: leftover body bytes must not
    # be parsed as a second request on the kept-alive connection.
    assert len(responses) == 1, responses
    status, response_headers, response_body = responses[0]
    request.last_headers = response_headers
    return status, response_body


def parse_responses(data: bytes):
    responses = []
    while data:
        head, _, rest = data.partition(b"\r\n\r\n")
        lines = head.decode().split("\r\n")
        headers = {k.strip().lower(): v.strip() for k, v in (line.split(":", 1) for line in lines[1:])}
        length = int(headers.get("content-length", "0"))
        responses.append((int(lines[0].split(" ")[1]), headers, json.loads(rest[:length].decode() or "null")))
        data = rest[length:]
    return responses


class AuthTests(unittest.TestCase):
    def test_missing_token_is_rejected_before_routing(self):
        service = FakeService()
        status, body = request(service, "GET", "/health", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(body, {"error": "unauthorized"})
        self.assertEqual(service.calls, [])

    def test_wrong_token_is_rejected_and_the_unread_body_ends_the_connection(self):
        service = FakeService()
        status, _ = request(service, "POST", "/add", {"messages": []}, token="nope")
        self.assertEqual(status, 401)
        self.assertEqual(request.last_headers.get("connection"), "close")
        self.assertEqual(service.calls, [])

    def test_right_token_reaches_the_service(self):
        service = FakeService()
        status, body = request(service, "GET", "/health")
        self.assertEqual((status, body), (200, {"ok": True}))


class BodyLimitTests(unittest.TestCase):
    def test_declared_body_over_the_limit_is_refused_without_reading(self):
        service = FakeService()
        status, body = request(
            service, "POST", "/add", b"{}", headers={"content-length": str(sidecar.MAX_BODY_BYTES + 1)}
        )
        self.assertEqual(status, 400)
        self.assertIn("too large", body["error"])
        self.assertEqual(service.calls, [])

    def test_invalid_content_length_and_non_object_json(self):
        service = FakeService()
        status, body = request(service, "POST", "/add", b"{}", headers={"content-length": "abc"})
        self.assertEqual(status, 400)
        self.assertIn("content-length", body["error"])
        status, body = request(service, "POST", "/add", [1, 2])
        self.assertEqual(status, 400)
        self.assertIn("JSON object", body["error"])
        status, body = request(service, "POST", "/add", b"not json")
        self.assertEqual(status, 400)


class RoutingTests(unittest.TestCase):
    def test_search_requires_a_query_and_defaults_filters_to_the_user(self):
        service = FakeService()
        status, _ = request(service, "POST", "/search", {"query": "  "})
        self.assertEqual(status, 400)
        status, body = request(service, "POST", "/search", {"query": "tea", "top_k": 3})
        self.assertEqual(status, 200)
        self.assertEqual(body["results"][0]["id"], "m1")
        self.assertEqual(service.calls[-1], ("search", "tea", {"user_id": "dsh-test-user"}, 3, None))

    def test_list_reads_filters_and_top_k_from_the_query(self):
        service = FakeService()
        request(service, "GET", "/memories?user_id=u2&top_k=7")
        self.assertEqual(service.calls[-1], ("list", {"user_id": "u2"}, 7))
        request(service, "GET", "/memories")
        self.assertEqual(service.calls[-1], ("list", {"user_id": "dsh-test-user"}, None))

    def test_memory_by_id_routes(self):
        service = FakeService()
        self.assertEqual(request(service, "GET", "/memories/m1")[0], 200)
        self.assertEqual(request(service, "GET", "/memories/missing")[0], 404)
        self.assertEqual(request(service, "PUT", "/memories/m1", {"text": "x"})[0], 200)
        self.assertEqual(service.calls[-1], ("update", "m1", {"text": "x"}))
        self.assertEqual(request(service, "DELETE", "/memories/m1")[0], 200)
        self.assertEqual(service.calls[-1], ("delete", "m1"))
        self.assertEqual(request(service, "GET", "/memories/a/b")[0], 404)

    def test_unknown_route_and_method_return_404(self):
        service = FakeService()
        self.assertEqual(request(service, "GET", "/nope")[0], 404)
        self.assertEqual(request(service, "DELETE", "/health")[0], 404)

    def test_service_errors_become_500_without_killing_the_handler(self):
        service = FakeService()

        def boom(_payload):
            raise RuntimeError("backend down")

        service.add = boom
        status, body = request(service, "POST", "/add", {"messages": []})
        self.assertEqual((status, body), (500, {"error": "backend down"}))


class ExtractionFailureTests(unittest.TestCase):
    def test_extraction_failure_is_a_502_with_reason(self):
        class Failing(FakeService):
            def add(self, payload):
                raise sidecar.LLMExtractionError("truncated")

        service = Failing()
        service.components = {"llm": {"provider": "openai", "endpoint": "127.0.0.1:64451"}}
        status, body = request(service, "POST", "/add", {"messages": "hi"})
        self.assertEqual(status, 502)
        self.assertEqual(body["code"], "LLM_EXTRACT_FAILED")
        self.assertEqual(body["reason"], "truncated")
        self.assertIs(body["retryable"], True)
        self.assertEqual((body["component"], body["step"]), ("llm", "llm_extract"))
        self.assertEqual((body["provider"], body["endpoint"]), ("openai", "127.0.0.1:64451"))
        self.assertIn("nothing was stored", body["error"])

    def test_refusal_is_not_retryable(self):
        class Failing(FakeService):
            def add(self, payload):
                raise sidecar.LLMExtractionError("refusal")

        status, body = request(Failing(), "POST", "/add", {"messages": "hi"})
        self.assertEqual((status, body["reason"], body["retryable"]), (502, "refusal", False))


if __name__ == "__main__":
    unittest.main()
