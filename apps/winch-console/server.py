#!/usr/bin/env python3
"""Winch console: MCP Apps server with a SIMULATED winch (no hardware).

Device-side interlocks live here, not in the UI: speed is clamped to +/-1.5 m/s,
an overload fault blocks hauling in, and the drum stops at its end limits.
"""
import json, math, os, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
UI_URI = "ui://winch-console/main"
MIME = "text/html;profile=mcp-app"
MAX_SPEED = 1.5      # m/s
CABLE_MAX = 40.0     # m paid out
LOCK = threading.Lock()
S = {"setpoint": 0.0, "speed": 0.0, "paid_out": 12.0, "load_kg": 180.0, "motor_temp_c": 34.0,
     "enabled": True, "faults": [], "history": [], "t0": time.time()}


def sim():
    while True:
        time.sleep(0.1)
        with LOCK:
            sp = S["setpoint"]
            if "OVERLOAD" in S["faults"] and sp < 0:
                sp = 0.0
            S["speed"] += max(-0.08, min(0.08, sp - S["speed"]))  # ramp limit
            S["paid_out"] = max(0.0, min(CABLE_MAX, S["paid_out"] + S["speed"] * 0.1))
            if S["paid_out"] in (0.0, CABLE_MAX):
                S["speed"] = 0.0
            t = time.time() - S["t0"]
            S["load_kg"] = 180 + 25 * math.sin(t / 3) + (60 if S["speed"] < -0.2 else 0)
            S["motor_temp_c"] += (abs(S["speed"]) * 0.05) - (S["motor_temp_c"] - 34) * 0.01
            if S["load_kg"] > 255 and "OVERLOAD" not in S["faults"]:
                S["faults"].append("OVERLOAD")
            S["history"].append(round(S["speed"], 3))
            S["history"] = S["history"][-120:]


def status():
    with LOCK:
        return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in S.items() if k != "t0"}


def text(t, structured=None, error=False):
    r = {"content": [{"type": "text", "text": t}]}
    if structured is not None:
        r["structuredContent"] = structured
    if error:
        r["isError"] = True
    return r


def call(name, args):
    if name == "read_status":
        st = status()
        return text("speed %.2f m/s (setpoint %.2f), paid out %.1f m, load %.0f kg, faults %s"
                    % (st["speed"], st["setpoint"], st["paid_out"], st["load_kg"], st["faults"] or "none"), st)
    if name == "set_speed":
        try:
            v = float(args.get("speed_mps"))
        except (TypeError, ValueError):
            return text("speed_mps must be a number", error=True)
        clamped = max(-MAX_SPEED, min(MAX_SPEED, v))
        with LOCK:
            if not S["enabled"]:
                return text("drive disabled", error=True)
            S["setpoint"] = clamped
        note = "" if clamped == v else " (clamped by device limit %.1f m/s)" % MAX_SPEED
        return text("setpoint %.2f m/s%s" % (clamped, note), status())
    if name == "stop":
        with LOCK:
            S["setpoint"] = 0.0
            S["faults"] = [f for f in S["faults"] if f != "OVERLOAD"]
        return text("stopping: setpoint 0, faults cleared", status())
    raise KeyError(name)


TOOLS = [
    {"name": "read_status", "description": "Winch telemetry: speed, setpoint, cable paid out, load, temperature, faults.",
     "inputSchema": {"type": "object", "properties": {}}, "annotations": {"readOnlyHint": True},
     "_meta": {"ui": {"resourceUri": UI_URI}}},
    {"name": "set_speed", "description": "Set drum speed in m/s (+ pays out, - hauls in). Device clamps to +/-1.5.",
     "inputSchema": {"type": "object", "properties": {"speed_mps": {"type": "number"}}, "required": ["speed_mps"]},
     "_meta": {"ui": {"resourceUri": UI_URI}}},
    {"name": "stop", "description": "Ramp to zero and clear an overload fault. Never needs confirmation.",
     "inputSchema": {"type": "object", "properties": {}}, "_meta": {"ui": {"resourceUri": UI_URI}}},
]


def send(m):
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()


def main():
    threading.Thread(target=sim, daemon=True).start()
    sys.stderr.write("winch-console: simulated device ready\n")
    sys.stderr.flush()
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            m = json.loads(line)
        except ValueError:
            continue
        mid, method, p = m.get("id"), m.get("method"), m.get("params") or {}
        if mid is None:
            continue
        try:
            if method == "initialize":
                res = {"protocolVersion": p.get("protocolVersion", "2025-06-18"), "serverInfo": {"name": "winch-console", "version": "0.3.0"},
                       "capabilities": {"tools": {}, "resources": {}}}
            elif method == "tools/list":
                res = {"tools": TOOLS}
            elif method == "tools/call":
                res = call(p.get("name"), p.get("arguments") or {})
            elif method == "resources/list":
                res = {"resources": [{"uri": UI_URI, "name": "Winch console", "mimeType": MIME}]}
            elif method == "resources/read":
                if p.get("uri") != UI_URI:
                    raise KeyError(p.get("uri"))
                with open(os.path.join(HERE, "ui.html")) as f:
                    html = f.read()
                res = {"contents": [{"uri": UI_URI, "mimeType": MIME, "text": html,
                                     "_meta": {"ui": {"csp": {"connectDomains": [], "resourceDomains": []}, "prefersBorder": False}}}]}
            elif method == "ping":
                res = {}
            else:
                send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found"}})
                continue
            send({"jsonrpc": "2.0", "id": mid, "result": res})
        except KeyError as e:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "unknown: %s" % e}})


if __name__ == "__main__":
    main()
