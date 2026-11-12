#!/usr/bin/env python3
"""A mock of the Messages API of the vendor, for the tests of the bridge.

No real model and no credential. It started from the mock model of the
bridge spike in the repository of the agent image, and it keeps its limit:
a request with more than four cache marks gets the error of the real API.

It answers by marks in the user texts of a request:

- `TOOL=<name>`: the first answer asks for the offered tool whose name is
  `<name>` or ends in `__<name>`, with the input `{"q": "<the ECHO mark>"}`.
  An answer after a tool result is text.
- `TOOLS2=<name>`: the same, with two calls of the tool in one answer.
- `ECHO=<word>`: the text answer holds `ECHO-<word>`.
- `DELAY=<seconds>`: the answer waits that long first.
- Else it answers `MOCK-OK`.

It keeps a record of each request in memory: the headers that tell the
client, which credential came (a label, never the value), the system
blocks, the tool names, the user texts and the shape of the messages.
`GET /_records` gives them as JSON. The tests read them there.
"""

import itertools
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_CACHE_MARKS = 4
UPSTREAM_KEY = os.environ.get("MOCK_UPSTREAM_KEY", "")
SHOWN_HEADERS = (
    "user-agent",
    "x-app",
    "anthropic-version",
    "anthropic-beta",
    "x-claude-code-session-id",
)
RECORDS = []
LOCK = threading.Lock()
MESSAGE_IDS = itertools.count(1)
TOOL_IDS = itertools.count(1)


def text_of(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif block.get("type") == "tool_result":
            parts.append(text_of(block.get("content")))
    return "\n".join(parts)


def cache_marks(node):
    if isinstance(node, dict):
        own = 1 if node.get("cache_control") is not None else 0
        return own + sum(cache_marks(v) for v in node.values())
    if isinstance(node, list):
        return sum(cache_marks(v) for v in node)
    return 0


def find(pattern, texts):
    for t in texts:
        m = re.search(pattern, t)
        if m:
            return m.group(1)
    return None


def tool_rounds(body):
    """The answers with a tool call in the history of a request."""
    n = 0
    for m in body.get("messages") or []:
        if m.get("role") == "assistant" and isinstance(m.get("content"), list):
            if any(isinstance(b, dict) and b.get("type") == "tool_use" for b in m["content"]):
                n += 1
    return n


def offered_tool(name, offered):
    if name in offered:
        return name
    return next((o for o in offered if o.endswith("__" + name)), None)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _event(self, event, data):
        self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
        self.wfile.flush()

    def credential(self):
        key = self.headers.get("x-api-key") or ""
        bearer = self.headers.get("authorization") or ""
        if not key and bearer.lower().startswith("bearer "):
            key = bearer[7:]
        if not key:
            return "none"
        return "upstream-key" if UPSTREAM_KEY and key == UPSTREAM_KEY else "other"

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/_records":
            with LOCK:
                return self._json(200, RECORDS)
        if path == "/health":
            return self._json(200, {"ok": True})
        return self._json(404, {"type": "error", "error": {"type": "not_found_error", "message": "mock"}})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) if length else b"{}")
        except ValueError:
            body = {}
        path = self.path.split("?", 1)[0]
        if path.endswith("/count_tokens"):
            return self._json(200, {"input_tokens": 1234})
        if not path.endswith("/v1/messages"):
            return self._json(404, {"type": "error", "error": {"type": "not_found_error", "message": "mock"}})
        system = body.get("system")
        if isinstance(system, str):
            system = [{"type": "text", "text": system}]
        user_texts = [text_of(m.get("content")) for m in body.get("messages") or [] if m.get("role") == "user"]
        record = {
            "ts": time.time(),
            "path": path,
            "credential": self.credential(),
            "headers": {k.lower(): v for k, v in self.headers.items() if k.lower() in SHOWN_HEADERS},
            "model": body.get("model"),
            "stream": bool(body.get("stream")),
            "system": [b.get("text", "") for b in system or [] if isinstance(b, dict)],
            "tools": [t.get("name") or t.get("type") for t in body.get("tools") or []],
            "other_tools": [t for t in body.get("tools") or [] if not str(t.get("name", "")).startswith("mcp__client__")],
            "tool_choice": body.get("tool_choice"),
            "keys": sorted(body.keys()),
            "metadata": body.get("metadata"),
            "temperature": body.get("temperature"),
            "cache_marks": cache_marks(body),
            "messages": [
                {
                    "role": m.get("role"),
                    "blocks": ["text"]
                    if isinstance(m.get("content"), str)
                    else [b.get("type") for b in m.get("content") or [] if isinstance(b, dict)],
                }
                for m in body.get("messages") or []
            ],
            "user_texts": user_texts,
            "system_messages": [text_of(m.get("content")) for m in body.get("messages") or [] if m.get("role") == "system"],
        }
        if record["cache_marks"] > MAX_CACHE_MARKS:
            record["refused"] = "cache_control"
            with LOCK:
                RECORDS.append(record)
            return self._json(
                400,
                {
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "message": "A maximum of 4 blocks with cache_control may be provided. "
                        f"Found {record['cache_marks']}.",
                    },
                },
            )
        with LOCK:
            RECORDS.append(record)
        delay = find(r"DELAY=([0-9.]+)", user_texts)
        if delay:
            time.sleep(min(float(delay), 60))
        content = self.answer(body, user_texts)
        record["answer"] = [b.get("name") or b.get("text") for b in content]
        self.reply(body, content)

    def answer(self, body, texts):
        echo = find(r"ECHO=([A-Za-z0-9-]+)", texts) or ""
        offered = [t.get("name") for t in body.get("tools") or []]
        tool = find(r"TOOL=([A-Za-z0-9_-]+)", texts)
        two = find(r"TOOLS2=([A-Za-z0-9_-]+)", texts)
        wanted = two or tool
        if wanted and tool_rounds(body) == 0:
            name = offered_tool(wanted, offered)
            if not name:
                return [{"type": "text", "text": f"MOCK-NOT-OFFERED {wanted}"}]
            return [
                {
                    "type": "tool_use",
                    "id": f"toolu_mock{next(TOOL_IDS):05d}",
                    "name": name,
                    "input": {"q": echo or "none", "n": i},
                }
                for i in range(2 if two else 1)
            ]
        text = "MOCK-OK"
        if echo:
            text += f" ECHO-{echo}"
        return [{"type": "text", "text": text}]

    def reply(self, body, content):
        stop = "tool_use" if any(b["type"] == "tool_use" for b in content) else "end_turn"
        usage = {
            "input_tokens": 11,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "output_tokens": 22,
        }
        msg = {
            "id": f"msg_mock{next(MESSAGE_IDS):05d}",
            "type": "message",
            "role": "assistant",
            "model": body.get("model", "claude-test"),
            "content": content,
            "stop_reason": stop,
            "stop_sequence": None,
            "usage": usage,
        }
        if not body.get("stream"):
            return self._json(200, msg)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        start = dict(msg, content=[], stop_reason=None, usage=dict(usage, output_tokens=1))
        self._event("message_start", {"type": "message_start", "message": start})
        for i, block in enumerate(content):
            if block["type"] == "text":
                first = {"type": "text", "text": ""}
                delta = {"type": "text_delta", "text": block["text"]}
            else:
                first = dict(block, input={})
                delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
            self._event("content_block_start", {"type": "content_block_start", "index": i, "content_block": first})
            self._event("content_block_delta", {"type": "content_block_delta", "index": i, "delta": delta})
            self._event("content_block_stop", {"type": "content_block_stop", "index": i})
        self._event(
            "message_delta",
            {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": usage},
        )
        self._event("message_stop", {"type": "message_stop"})
        self.close_connection = True


if __name__ == "__main__":
    host = os.environ.get("MOCK_HOST", "127.0.0.1")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(json.dumps({"mock": "listening", "host": host, "port": port}), flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
