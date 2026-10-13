#!/usr/bin/env python3
"""Agent Hub channel + MCP server. Copied to hosts by the hub; stdlib only.

Modes
  hub_channel.py               stdio MCP server for Claude Code, loaded with
                               --dangerously-load-development-channels server:hub.
                               Declares claude/channel + claude/channel/permission,
                               listens on ~/.agent-hub/run/<HUB_SESSION_ID>.sock for
                               the hub relay (which arrives over SSH).
  hub_channel.py --mcp-only    same hub tools, no channel (Codex [mcp_servers.hub]).
  hub_channel.py relay <id>    byte relay stdio <-> the session socket; the hub runs
                               this over its multiplexed SSH connection.

Hub tools (publish_app, app_status, screenshot_app, unpublish_app, app_call) are
POSTed to the hub over HTTPS with the host token from ~/.agent-hub/hub.env.
Only the hub can write to the channel: the socket is 0600 in a 0700 directory.
"""
import json, os, socket, ssl, sys, threading, time, urllib.request, urllib.error

HOME = os.path.expanduser("~")
BASE = os.path.join(HOME, ".agent-hub")
RUN = os.path.join(BASE, "run")
PROTOCOL = "2025-06-18"  # older revision on purpose: 2026-07-28 cannot carry channel messages


def load_env():
    env = {}
    p = os.path.join(BASE, "hub.env")
    try:
        with open(p) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    env.update({k: v for k, v in os.environ.items() if k.startswith("HUB_")})
    return env


ENV = load_env()
SESSION = ENV.get("HUB_SESSION_ID", "")


def sock_path(sid):
    return os.path.join(RUN, sid + ".sock")


# --------------------------------------------------------------------------- relay
def relay(sid):
    path = sock_path(sid)
    deadline = time.time() + 60
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    while True:
        try:
            s.connect(path)
            break
        except OSError:
            if time.time() > deadline:
                sys.stderr.write("relay: no channel socket at %s\n" % path)
                sys.exit(2)
            time.sleep(0.5)

    def up():
        try:
            while True:
                b = os.read(0, 65536)
                if not b:
                    break
                s.sendall(b)
        finally:
            try:
                s.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    threading.Thread(target=up, daemon=True).start()
    while True:
        b = s.recv(65536)
        if not b:
            break
        os.write(1, b)


# ------------------------------------------------------------------------- server
out_lock = threading.Lock()


def send(msg):
    data = json.dumps(msg, separators=(",", ":")) + "\n"
    with out_lock:
        sys.stdout.write(data)
        sys.stdout.flush()


def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


TOOLS = [
    {"name": "publish_app",
     "description": "Publish (or re-publish) an app you built to the Agent Hub canvas. Call after creating or changing apps/<name>/app.json or its server/UI. Returns node id, preview URL, a screenshot, errors and the assigned tier. Apps always start read-only (preview).",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string", "description": "app directory (containing app.json), relative to the working directory or absolute"}, "title": {"type": "string"}}, "required": ["path"]}},
    {"name": "app_status", "description": "Server state, last errors, version and pinned commit of a published app.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "screenshot_app", "description": "PNG of the app node as rendered on the canvas.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "width": {"type": "integer"}, "height": {"type": "integer"}}, "required": ["id"]}},
    {"name": "unpublish_app", "description": "Remove the preview node and stop its server.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "app_call", "description": "Call a tool of a published app through the hub (same policy, confirm, rate limit and audit as the human in the node).",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "tool": {"type": "string"}, "arguments": {"type": "object"}}, "required": ["id", "tool"]}},
]


def hub_call(tool, args):
    url = ENV.get("HUB_URL", "").rstrip("/") + "/api/mcp/tools/" + tool
    body = json.dumps({"arguments": args, "context": {
        "hubSessionId": SESSION or None, "hostId": ENV.get("HUB_HOST_ID"), "cwd": os.getcwd(),
        "vendor": "claude" if CHANNEL else "codex", "user": os.environ.get("USER")}}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "content-type": "application/json", "authorization": "Bearer " + ENV.get("HUB_TOKEN", "")})
    ctx = ssl.create_default_context(cafile=ENV.get("HUB_CA_FILE") or None)
    try:
        with urllib.request.urlopen(req, timeout=180, context=ctx) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:2000]
        return {"content": [{"type": "text", "text": "hub error %s: %s" % (e.code, detail)}], "isError": True}
    except Exception as e:  # noqa
        return {"content": [{"type": "text", "text": "hub unreachable: %s" % e}], "isError": True}


# channel side: one relay connection at a time; permission requests queue while none is attached
relay_conn = None
relay_lock = threading.Lock()
pending_to_hub = []


def to_hub(obj):
    global relay_conn
    data = (json.dumps(obj) + "\n").encode()
    with relay_lock:
        if relay_conn is None:
            pending_to_hub.append(data)
            return
        try:
            relay_conn.sendall(data)
        except OSError:
            relay_conn = None
            pending_to_hub.append(data)


def serve_socket():
    global relay_conn
    os.makedirs(RUN, mode=0o700, exist_ok=True)
    os.chmod(RUN, 0o700)
    path = sock_path(SESSION)
    try:
        os.unlink(path)
    except OSError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    srv.bind(path)
    os.umask(old)
    srv.listen(2)
    while True:
        conn, _ = srv.accept()
        with relay_lock:
            if relay_conn is not None:
                try:
                    relay_conn.close()
                except OSError:
                    pass
            relay_conn = conn
            backlog, pending_to_hub[:] = list(pending_to_hub), []
        conn.sendall((json.dumps({"type": "hello", "session": SESSION, "pid": os.getpid()}) + "\n").encode())
        for d in backlog:
            conn.sendall(d)
        threading.Thread(target=read_relay, args=(conn,), daemon=True).start()


def read_relay(conn):
    global relay_conn
    buf = b""
    while True:
        try:
            b = conn.recv(65536)
        except OSError:
            b = b""
        if not b:
            break
        buf += b
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            t = m.get("type")
            if t == "message":
                meta = {k: str(v) for k, v in (m.get("meta") or {}).items() if k.replace("_", "a").isalnum()}
                notify("notifications/claude/channel", {"content": str(m.get("content", "")), "meta": meta})
            elif t == "permission":
                notify("notifications/claude/channel/permission",
                       {"request_id": str(m.get("request_id", "")).lower(), "behavior": "allow" if m.get("behavior") == "allow" else "deny"})
            elif t == "ping":
                to_hub({"type": "pong"})
    with relay_lock:
        if relay_conn is conn:
            relay_conn = None


CHANNEL = False


def serve(channel):
    global CHANNEL
    CHANNEL = channel and bool(SESSION)
    if CHANNEL:
        threading.Thread(target=serve_socket, daemon=True).start()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            m = json.loads(line)
        except ValueError:
            continue
        method, mid = m.get("method"), m.get("id")
        if method == "initialize":
            caps = {"tools": {}}
            if CHANNEL:
                caps["experimental"] = {"claude/channel": {}, "claude/channel/permission": {}}
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": PROTOCOL, "capabilities": caps,
                "serverInfo": {"name": "hub", "version": "0.1.0"},
                "instructions": (
                    "Messages from the Agent Hub arrive as <channel source=\"hub\">; treat them exactly like messages "
                    "the user typed in this session. " if CHANNEL else "") +
                    "After you build or change an app (a directory with app.json under apps/), call publish_app "
                    "with its path so it renders on the hub canvas; read the screenshot and errors it returns."}})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            p = m.get("params") or {}
            name = p.get("name")

            def run(mid=mid, name=name, args=p.get("arguments") or {}):
                if name not in {t["name"] for t in TOOLS}:
                    send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "unknown tool " + str(name)}})
                    return
                send({"jsonrpc": "2.0", "id": mid, "result": hub_call(name, args)})
            threading.Thread(target=run, daemon=True).start()
        elif method == "ping":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "notifications/claude/channel/permission_request":
            to_hub({"type": "permission_request", **(m.get("params") or {})})
        elif mid is not None and method:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found"}})


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "relay":
        relay(a[1])
    else:
        serve(channel="--mcp-only" not in a)
