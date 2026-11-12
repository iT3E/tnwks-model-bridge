"""The test rig of the bridge: a mock upstream, two bridges, and in CI a
model gateway in front.

Two modes:

- `container` (CI, `bin/image-test`): the image under test runs as two
  containers with a read-only root file system, a temporary file system on
  /tmp, no capability and a user that is not root. The mock upstream and
  the model gateway run as containers on the same Docker network. Each port
  is published on the loopback address of the runner only.
- `process` (a workstation): the mock and the bridge run as processes on
  the loopback address, with a clean environment. No container, no image.

In both modes the engine gets a fake key and the mock as its upstream, and
a proxy address that refuses each connection for any other host.
"""

import http.client
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(REPO, "tests")

# Fake values only. None of them is a real credential.
UPSTREAM_KEY = "fake-upstream-key-" + secrets.token_hex(8)
KEYS = {
    "main": "fake-bridge-key-main-" + secrets.token_hex(12),
    "finance": "fake-bridge-key-finance-" + secrets.token_hex(12),
    "workflows": "fake-bridge-key-workflows-" + secrets.token_hex(12),
}
GATEWAY_MASTER_KEY = "sk-fake-gateway-" + secrets.token_hex(12)
# A proxy address where nothing listens: a call of the engine to any host
# but the mock fails.
DEAD_PROXY = "http://127.0.0.1:9"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(port, path="/health", timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            conn.request("GET", path)
            ok = conn.getresponse().status == 200
            conn.close()
            if ok:
                return
        except OSError:
            pass
        time.sleep(0.3)
    raise RuntimeError(f"nothing answered on port {port}{path} in {timeout} s")


def run(cmd, check=True, **kw):
    return subprocess.run(cmd, check=check, text=True, capture_output=True, **kw)


class Bridge:
    """One bridge under test."""

    def __init__(self, rig, name, max_conversations, extra_env=None):
        self.rig = rig
        self.name = name
        self.max_conversations = max_conversations
        self.extra_env = dict(extra_env or {})
        self.port = free_port()
        self.state_dir = None
        self.proc = None
        self.log_path = None

    def env(self, upstream):
        return {
            "BRIDGE_KEY_MAIN": KEYS["main"],
            "BRIDGE_KEY_FINANCE": KEYS["finance"],
            "BRIDGE_KEY_WORKFLOWS": KEYS["workflows"],
            "BRIDGE_MAX_CONVERSATIONS": str(self.max_conversations),
            "BRIDGE_CALL_SECONDS": "90",
            "ANTHROPIC_BASE_URL": upstream,
            "ANTHROPIC_API_KEY": UPSTREAM_KEY,
            "HTTPS_PROXY": DEAD_PROXY,
            "HTTP_PROXY": DEAD_PROXY,
            "NO_PROXY": "mock,127.0.0.1,localhost",
            **self.extra_env,
        }

    def log(self):
        if self.rig.mode == "container":
            out = run(["docker", "logs", self.container], check=False)
            return out.stdout + out.stderr
        with open(self.log_path, encoding="utf-8", errors="replace") as f:
            return f.read()

    def log_lines(self):
        lines = []
        for raw in self.log().splitlines():
            try:
                lines.append(json.loads(raw))
            except ValueError:
                lines.append({"event": "not_json", "raw": raw})
        return lines

    @property
    def container(self):
        return f"{self.rig.prefix}-{self.name}"

    def sh(self, script):
        """A shell command where the bridge runs, as its user."""
        if self.rig.mode == "container":
            return run(["docker", "exec", self.container, "sh", "-c", script], check=False)
        return run(["sh", "-c", script], check=False)

    def terminate(self):
        """SIGTERM, as the kubelet sends it when it stops the pod."""
        if self.rig.mode == "container":
            run(["docker", "kill", "--signal", "TERM", self.container])
        else:
            self.proc.send_signal(signal.SIGTERM)

    def wait_exit(self, timeout):
        """The exit code of the bridge, or None when it still runs."""
        if self.rig.mode == "container":
            try:
                res = run(["docker", "wait", self.container], timeout=timeout)
            except subprocess.TimeoutExpired:
                return None
            return int(res.stdout.strip())
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None

    @property
    def state(self):
        """The state directory of the bridge, as the bridge sees it."""
        return "/tmp/tnwks-model-bridge" if self.rig.mode == "container" else self.state_dir


class Rig:
    def __init__(self):
        self.image = os.environ.get("IMAGE_REF", "")
        self.mode = "container" if self.image else "process"
        self.prefix = "mbt-" + uuid.uuid4().hex[:8]
        self.work = tempfile.mkdtemp(prefix="bridge-test-")
        self.mock_port = free_port()
        self.gateway_port = free_port()
        self.bridges = {"main": Bridge(self, "bridge", 8), "small": Bridge(self, "small", 2)}
        # Bridges that a test starts for itself, such as one that it stops.
        self.extras = {}
        self.procs = []
        self.containers = []

    # ---------------------------------------------------------------- start
    def start(self):
        if self.mode == "container":
            self._start_containers()
        else:
            self._start_processes()
        wait_http(self.mock_port)
        for b in self.bridges.values():
            wait_http(b.port)
        if self.mode == "container":
            wait_http(self.gateway_port, "/health/liveliness", timeout=180)

    def _start_processes(self):
        mock_log = open(os.path.join(self.work, "mock.log"), "w")
        self.procs.append(
            subprocess.Popen(
                [sys.executable, "-I", os.path.join(TESTS, "mock-model", "mock.py"), str(self.mock_port)],
                env={"PATH": os.environ.get("PATH", ""), "MOCK_UPSTREAM_KEY": UPSTREAM_KEY},
                stdout=mock_log,
                stderr=subprocess.STDOUT,
            )
        )
        for b in self.bridges.values():
            self._start_bridge_process(b)

    def _start_bridge_process(self, b):
        node = shutil.which("node")
        b.state_dir = os.path.join(self.work, f"state-{b.name}")
        b.log_path = os.path.join(self.work, f"{b.name}.log")
        env = {
            "PATH": os.path.dirname(node) + ":/usr/bin:/bin",
            "HOME": os.path.join(self.work, "home"),
            "BRIDGE_HOST": "127.0.0.1",
            "BRIDGE_PORT": str(b.port),
            "BRIDGE_STATE_DIR": b.state_dir,
            **b.env(f"http://127.0.0.1:{self.mock_port}"),
        }
        b.proc = subprocess.Popen(
            [node, os.path.join(REPO, "src", "bridge.mjs")],
            env=env,
            cwd=self.work,
            stdout=open(b.log_path, "w"),
            stderr=subprocess.STDOUT,
        )
        self.procs.append(b.proc)

    def spawn(self, name, max_conversations=4, **env):
        """One more bridge, of the same image or source, for one test."""
        b = Bridge(self, name, max_conversations, env)
        self.extras[name] = b
        if self.mode == "container":
            self._start_bridge_container(b)
        else:
            self._start_bridge_process(b)
        wait_http(b.port)
        return b

    def _start_containers(self):
        net = self.prefix
        run(["docker", "network", "create", net])
        mock_image = f"{self.prefix}-mock:test"
        run(["docker", "build", "-q", "-t", mock_image, os.path.join(TESTS, "mock-model")])
        self._container(
            "mock",
            ["--network-alias", "mock", "-p", f"127.0.0.1:{self.mock_port}:8000", "-e", f"MOCK_UPSTREAM_KEY={UPSTREAM_KEY}"],
            mock_image,
        )
        for b in self.bridges.values():
            self._start_bridge_container(b)
        gateway_image = f"{self.prefix}-gateway:test"
        run(["docker", "build", "-q", "-t", gateway_image, os.path.join(TESTS, "model-gateway")])
        self._container(
            "gateway",
            [
                "-p",
                f"127.0.0.1:{self.gateway_port}:4000",
                "-e",
                f"LITELLM_MASTER_KEY={GATEWAY_MASTER_KEY}",
                "-e",
                f"BRIDGE_KEY_WORKFLOWS={KEYS['workflows']}",
            ],
            gateway_image,
            ["--config", "/config/config.yaml", "--port", "4000"],
        )

    def _start_bridge_container(self, b):
        args = [
            "--network-alias",
            b.name,
            "-p",
            f"127.0.0.1:{b.port}:8080",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "-e",
            "BRIDGE_HOST=0.0.0.0",
        ]
        for k, v in b.env("http://mock:8000").items():
            args += ["-e", f"{k}={v}"]
        self._container(b.name, args, self.image)

    def _container(self, name, args, image, cmd=()):
        full = f"{self.prefix}-{name}"
        run(["docker", "run", "-d", "--name", full, "--network", self.prefix, *args, image, *cmd])
        self.containers.append(full)

    # ----------------------------------------------------------------- stop
    def stop(self):
        for p in self.procs:
            p.send_signal(signal.SIGTERM)
        for p in self.procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        for c in self.containers:
            run(["docker", "rm", "-f", c], check=False)
        if self.mode == "container":
            run(["docker", "network", "rm", self.prefix], check=False)
        shutil.rmtree(self.work, ignore_errors=True)

    def dump(self, out=sys.stderr):
        """The logs, for a failed run. They hold fake values only."""
        for b in [*self.bridges.values(), *self.extras.values()]:
            print(f"==== the log of {b.name}", file=out)
            print(b.log()[-20000:], file=out)
        if self.mode == "container":
            for name in ("mock", "gateway"):
                res = run(["docker", "logs", "--tail", "80", f"{self.prefix}-{name}"], check=False)
                print(f"==== the log of {name}", file=out)
                print((res.stdout + res.stderr)[-8000:], file=out)

    # ---------------------------------------------------------------- mock
    def records(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.mock_port, timeout=10)
        try:
            conn.request("GET", "/_records")
            return json.loads(conn.getresponse().read())
        finally:
            conn.close()


class Response:
    def __init__(self, status, headers, body, events):
        self.status = status
        self.headers = headers
        self.body = body
        self.events = events

    @property
    def mode(self):
        return self.headers.get("x-bridge-mode")

    @property
    def conversation(self):
        return self.headers.get("x-bridge-conversation")

    def message(self):
        """The answer as one message, from the JSON body or the events."""
        if not self.events:
            return self.body
        msg = None
        parts = {}
        for ev in self.events:
            t = ev.get("type")
            if t == "message_start":
                msg = dict(ev["message"], content=[])
            elif t == "content_block_start":
                block = dict(ev["content_block"])
                msg["content"].append(block)
                parts[ev["index"]] = ""
            elif t == "content_block_delta":
                d = ev["delta"]
                block = msg["content"][-1]
                if d["type"] == "text_delta":
                    block["text"] = block.get("text", "") + d["text"]
                elif d["type"] == "input_json_delta":
                    parts[ev["index"]] += d["partial_json"]
            elif t == "content_block_stop":
                block = msg["content"][-1]
                if block.get("type") == "tool_use":
                    block["input"] = json.loads(parts[ev["index"]] or "{}")
            elif t == "message_delta":
                msg.update(ev.get("delta", {}))
        return msg


def call(port, body, key=None, headers=None, timeout=120):
    """POST /v1/messages. `key` goes in x-api-key."""
    h = {"content-type": "application/json", "anthropic-version": "2023-06-01"}
    if key is not None:
        h["x-api-key"] = key
    h.update(headers or {})
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request("POST", "/v1/messages", body=json.dumps(body), headers=h)
    res = conn.getresponse()
    raw = res.read().decode("utf-8", errors="replace")
    hdrs = {k.lower(): v for k, v in res.getheaders()}
    conn.close()
    return parsed(res.status, hdrs, raw)


class Pipe:
    """One connection that sends requests one after the other, with no wait
    for an answer (HTTP/1.1 pipelining), and reads all answers at the end.
    With it a test can send a call on a connection that is open when the
    bridge gets SIGTERM."""

    def __init__(self, port, timeout=120):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)

    def post(self, body, key):
        data = json.dumps(body).encode()
        head = (
            "POST /v1/messages HTTP/1.1\r\nHost: bridge\r\ncontent-type: application/json\r\n"
            f"anthropic-version: 2023-06-01\r\nx-api-key: {key}\r\ncontent-length: {len(data)}\r\n\r\n"
        )
        self.sock.sendall(head.encode() + data)

    def get(self, path):
        self.sock.sendall(f"GET {path} HTTP/1.1\r\nHost: bridge\r\n\r\n".encode())

    def responses(self):
        """Each answer, after the bridge closed the connection."""
        data = b""
        while True:
            chunk = self.sock.recv(65536)
            if not chunk:
                break
            data += chunk
        self.sock.close()
        out = []
        while data:
            head, _, rest = data.partition(b"\r\n\r\n")
            lines = head.decode("latin-1").split("\r\n")
            status = int(lines[0].split()[1])
            hdrs = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
            if "content-length" in hdrs:
                n = int(hdrs["content-length"])
                raw, data = rest[:n], rest[n:]
            elif hdrs.get("transfer-encoding") == "chunked":
                raw = b""
                while True:
                    size_line, _, rest = rest.partition(b"\r\n")
                    size = int(size_line.split(b";")[0] or b"0", 16)
                    if size == 0:
                        rest = rest[2:]
                        break
                    raw += rest[:size]
                    rest = rest[size + 2 :]
                data = rest
            else:
                raw, data = rest, b""
            out.append(parsed(status, hdrs, raw.decode("utf-8", errors="replace")))
        return out


def parsed(status, hdrs, raw):
    events = []
    data = None
    if hdrs.get("content-type", "").startswith("text/event-stream"):
        for chunk in raw.split("\n\n"):
            for line in chunk.splitlines():
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
    else:
        try:
            data = json.loads(raw)
        except ValueError:
            data = {"raw": raw}
    return Response(status, hdrs, data, events)
