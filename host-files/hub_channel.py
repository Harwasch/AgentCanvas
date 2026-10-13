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
  hub_channel.py --external    stdio MCP server on YOUR machine (Claude Desktop): proxies
                               the hub's canvas tools from HUB_MCP_URL (…/mcp) with the
                               bearer HUB_MCP_TOKEN. Nothing else is needed on that machine.

Canvas tools (canvas_*, hub_*) are listed by the hub itself (GET /api/mcp/tools), so
they stay in step with the hub version without re-copying this script.

Hub tools (publish_app, app_status, screenshot_app, unpublish_app, app_call) are
POSTed to the hub over HTTPS with this host's token from ~/.agent-hub/hub.env; a session
started by the hub adds its own HUB_SESSION_TOKEN (from its environment) so the hub knows
which session is calling.
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
    {"name": "request_review",
     "description": "Ask the user to review a file you produced (report, figure, plan). It appears as a review node with your note and checklist; the decision (approve / request changes) arrives as a message in this session.",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string", "description": "file path, relative to the repo root or absolute"}, "title": {"type": "string"}, "note": {"type": "string", "description": "what the user should check"},
                     "checklist": {"type": "array", "items": {"type": "string"}}, "promote_to": {"type": "string", "description": "where the file goes once approved"}}, "required": ["path"]}},
    {"name": "suggest_followup", "description": "Suggest a follow-up task as a node the user can launch as a new agent session.",
     "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "prompt": {"type": "string"}, "rationale": {"type": "string"}, "vendor": {"type": "string", "enum": ["claude", "codex"]}, "host": {"type": "string"}}, "required": ["title"]}},
    {"name": "add_todo", "description": "Add a to-do for the user (shown under this session and in the project's to-do list).",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "list_devices", "description": "Bench devices on this host (status, who holds each lock) and runnable HIL plans.",
     "inputSchema": {"type": "object", "properties": {"all": {"type": "boolean", "description": "include other hosts"}}}},
    {"name": "acquire_device", "description": "Lock a bench device for this session before driving it (apps that declare the device refuse actuate calls otherwise).",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "release_device", "description": "Release a device lock this session holds.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "request_compute", "description": "Ask for access to another host (e.g. a GPU node). Usable with run_on_host after the user approves the grant.",
     "inputSchema": {"type": "object", "properties": {"host": {"type": "string"}, "resources": {"type": "string"}, "purpose": {"type": "string"}, "quota_gb": {"type": "number"}}, "required": ["host", "purpose"]}},
    {"name": "run_on_host", "description": "Run a shell command on a host you hold an active compute grant for; returns exit code and output (audited).",
     "inputSchema": {"type": "object", "properties": {"grant_id": {"type": "string"}, "command": {"type": "string"}, "cwd": {"type": "string"}}, "required": ["grant_id", "command"]}},
    {"name": "run_hil", "description": "Start a hardware-in-the-loop test plan (the hub takes the plan's device locks); results arrive as a message in this session.",
     "inputSchema": {"type": "object", "properties": {"plan": {"type": "string"}, "only": {"type": "array", "items": {"type": "string"}}}, "required": ["plan"]}},
]


_hub_tools = {"at": 0, "tools": []}


def hub_tools():
    """Canvas tools served by the hub (cached for a minute); empty if the hub is unreachable."""
    if time.time() - _hub_tools["at"] < 60 and _hub_tools["tools"]:
        return _hub_tools["tools"]
    url = ENV.get("HUB_URL", "").rstrip("/") + "/api/mcp/tools"
    req = urllib.request.Request(url, headers={"authorization": "Bearer " + ENV.get("HUB_TOKEN", "")})
    ctx = ssl.create_default_context(cafile=ENV.get("HUB_CA_FILE") or None)
    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
            _hub_tools["tools"] = json.loads(r.read().decode()).get("tools") or []
            _hub_tools["at"] = time.time()
    except Exception:  # noqa
        pass
    return _hub_tools["tools"]


def all_tools():
    names = {t["name"] for t in TOOLS}
    return TOOLS + [t for t in hub_tools() if t.get("name") not in names]


def hub_call(tool, args):
    url = ENV.get("HUB_URL", "").rstrip("/") + "/api/mcp/tools/" + tool
    # host token in the Authorization header; a hub-started Claude session also proves its id with its own secret
    body = json.dumps({"arguments": args, "context": {
        "hubSessionId": SESSION or None, "hubSessionToken": ENV.get("HUB_SESSION_TOKEN") or None,
        "hostId": ENV.get("HUB_HOST_ID"), "cwd": os.getcwd(),
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

CANVAS_HELP = (
    "The canvas_* and hub_* tools act on the Agent Hub canvas: canvas_snapshot shows node ids, positions and the "
    "user's selection; arranging, notes, files and to-dos apply live (the user can undo); hub_* actions such as "
    "starting sessions or running HIL wait for the user to confirm in the hub.")
ASSISTANT_HELP = (
    " You are the canvas assistant of the Agent Hub: the user talks to you from the hub's Ask Claude panel. "
    "Do what they ask on the canvas with these tools (start with canvas_snapshot; messages may name the nodes they "
    "selected), then answer in one or two short sentences saying what you changed. You cannot approve agents' tool "
    "calls or actuate hardware; say so if asked.")


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
            role = ENV.get("HUB_ROLE", "")
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
                    "with its path so it renders on the hub canvas; read the screenshot and errors it returns. " +
                    CANVAS_HELP + (ASSISTANT_HELP if role == "assistant" else "")}})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": mid, "result": {"tools": all_tools()}})
        elif method == "tools/call":
            p = m.get("params") or {}
            name = p.get("name")

            def run(mid=mid, name=name, args=p.get("arguments") or {}):
                if name not in {t["name"] for t in all_tools()}:
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


def external():
    """stdio <-> the hub's /mcp endpoint, one JSON-RPC message per POST."""
    url = os.environ.get("HUB_MCP_URL", "")
    tok = os.environ.get("HUB_MCP_TOKEN", "")
    ctx = ssl.create_default_context(cafile=os.environ.get("HUB_CA_FILE") or None)
    workers = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            m = json.loads(line)
        except ValueError:
            continue

        def run(m=m):
            req = urllib.request.Request(url, data=json.dumps(m).encode(), method="POST", headers={
                "content-type": "application/json", "accept": "application/json, text/event-stream",
                "authorization": "Bearer " + tok, "x-hub-client": os.environ.get("HUB_CLIENT_NAME", "Claude Desktop")})
            try:
                with urllib.request.urlopen(req, timeout=900, context=ctx) as r:
                    body = r.read().decode()
                if body.strip() and m.get("id") is not None:
                    send(json.loads(body))
            except Exception as e:  # noqa
                if m.get("id") is not None:
                    send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32000, "message": "hub unreachable: %s" % e}})
        t = threading.Thread(target=run, daemon=True)
        t.start()
        workers.append(t)
        workers[:] = [w for w in workers if w.is_alive()]
    for w in workers:  # stdin closed: let in-flight calls answer before exiting
        w.join(timeout=30)


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "--external":
        external()
    elif a and a[0] == "relay":
        relay(a[1])
    else:
        serve(channel="--mcp-only" not in a)
