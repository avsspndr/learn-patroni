import concurrent.futures
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


STATIC_DIR = Path(__file__).parent / "static"
LISTEN_HOST = os.getenv("DASHBOARD_HOST", "0.0.0.0")
LISTEN_PORT = int(os.getenv("DASHBOARD_PORT", "8080"))
REQUEST_TIMEOUT = float(os.getenv("PATRONI_TIMEOUT", "2"))
ETCD_URL = os.getenv("ETCD_URL", "http://etcd:2379").rstrip("/")
ETCD_EXPECTED_MEMBERS = int(os.getenv("ETCD_EXPECTED_MEMBERS", "1"))
ETCD_SINGLE_NODE_INTENTIONAL = os.getenv("ETCD_SINGLE_NODE_INTENTIONAL", "false").lower() in {"1", "true", "yes"}
LAG_HISTORY = defaultdict(lambda: deque(maxlen=90))
LAG_HISTORY_LOCK = threading.Lock()
STATE_HISTORY = deque(maxlen=180)
STATE_HISTORY_LOCK = threading.Lock()


def parse_nodes(raw_value):
    nodes = {}
    for item in raw_value.split(","):
        name, separator, url = item.strip().partition("=")
        if separator and name and url:
            nodes[name] = url.rstrip("/")
    if not nodes:
        raise ValueError("PATRONI_NODES must contain name=url pairs")
    return nodes


def tcp_endpoint(host, port):
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=REQUEST_TIMEOUT):
            return {"available": True, "latency_ms": round((time.monotonic() - started) * 1000, 1)}
    except OSError as error:
        return {"available": False, "latency_ms": None, "error": str(error)}


PATRONI_NODES = parse_nodes(
    os.getenv(
        "PATRONI_NODES",
        "db1=http://db1:8008,db2=http://db2:8008",
    )
)
def patroni_route(base_url, path):
    try:
        _, latency_ms = request(f"{base_url}{path}")
        return {"available": True, "status": 200, "latency_ms": latency_ms}
    except urllib.error.HTTPError as error:
        return {"available": False, "status": error.code, "latency_ms": None}
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        return {"available": False, "status": None, "latency_ms": None, "error": str(error)}


def request(url, *, as_json=False, method="GET", payload=None):
    started = time.monotonic()
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"User-Agent": "patroni-dashboard/1.0"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as response:
        body = response.read().decode("utf-8")
        elapsed_ms = round((time.monotonic() - started) * 1000, 1)
        return (json.loads(body) if as_json else body), elapsed_ms


def patroni_action(base_url, path, method="POST", payload=None):
    body = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=body,
        method=method,
        headers={"Content-Type": "application/json", "User-Agent": "patroni-dashboard/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return {"ok": True, "status": response.status, "message": response.read().decode("utf-8")}
    except urllib.error.HTTPError as error:
        return {"ok": False, "status": error.code, "message": error.read().decode("utf-8")}
    except (urllib.error.URLError, TimeoutError) as error:
        return {"ok": False, "status": 503, "message": str(error)}


def parse_prometheus(text):
    samples = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        metric, separator, value = line.rpartition(" ")
        if not separator:
            continue
        try:
            samples[metric] = float(value)
        except ValueError:
            continue
    return samples


def lsn_to_int(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and "/" in value:
        high, separator, low = value.partition("/")
        if separator:
            try:
                return (int(high, 16) << 32) + int(low, 16)
            except ValueError:
                return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def replication_lag_snapshot(nodes, cluster, measured_at):
    topology_members = cluster.get("topology", {}).get("members", [])
    members = {member.get("name"): member for member in topology_members}
    primary_node = next(
        (
            node for node in nodes
            if node.get("reachable") and node.get("status", {}).get("role") in {"primary", "master"}
        ),
        None,
    )
    primary_lsn = lsn_to_int(primary_node.get("status", {}).get("xlog", {}).get("location")) if primary_node else None
    snapshots = {}

    for node in nodes:
        status = node.get("status", {})
        if not node.get("reachable") or status.get("role") != "replica":
            continue
        member = members.get(node.get("name"), {})
        received_lsn = lsn_to_int(status.get("xlog", {}).get("received_location"))
        replayed_lsn = lsn_to_int(status.get("xlog", {}).get("replayed_location"))
        if received_lsn is None:
            received_lsn = lsn_to_int(member.get("receive_lsn") or member.get("lsn"))
        if replayed_lsn is None:
            replayed_lsn = lsn_to_int(member.get("replay_lsn") or member.get("lsn"))

        derived_receive = max(primary_lsn - received_lsn, 0) if primary_lsn is not None and received_lsn is not None else None
        derived_apply = max(received_lsn - replayed_lsn, 0) if received_lsn is not None and replayed_lsn is not None else None
        derived_replay = max(primary_lsn - replayed_lsn, 0) if primary_lsn is not None and replayed_lsn is not None else None
        reported_receive = lsn_to_int(member.get("receive_lag"))
        reported_replay = lsn_to_int(member.get("replay_lag", member.get("lag")))

        receive_candidates = [value for value in (derived_receive, reported_receive) if value is not None]
        replay_candidates = [value for value in (derived_replay, reported_replay) if value is not None]
        snapshots[node["name"]] = {
            "timestamp": measured_at,
            "primary_lsn": primary_lsn,
            "received_lsn": received_lsn,
            "replayed_lsn": replayed_lsn,
            "receive_lag": max(receive_candidates) if receive_candidates else None,
            "apply_lag": derived_apply,
            "replay_lag": max(replay_candidates) if replay_candidates else None,
            "replication_state": status.get("replication_state") or member.get("state"),
            "sources": ["GET /patroni", "GET /cluster"],
        }
    return snapshots


def collect_node(name, base_url):
    result = {
        "name": name,
        "url": base_url,
        "reachable": False,
        "error": None,
        "status": {},
        "metrics": {},
        "latency_ms": None,
        "patroni_routes": {},
    }

    try:
        status, latency_ms = request(f"{base_url}/patroni", as_json=True)
        result["status"] = status
        result["latency_ms"] = latency_ms
        result["reachable"] = True
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
        result["error"] = str(error)
        return result

    try:
        metrics_text, _ = request(f"{base_url}/metrics")
        result["metrics"] = parse_prometheus(metrics_text)
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        result["metrics_error"] = str(error)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        read_write = executor.submit(patroni_route, base_url, "/read-write")
        read_only = executor.submit(patroni_route, base_url, "/read-only")
        result["patroni_routes"] = {"read_write": read_write.result(), "read_only": read_only.result()}

    return result


def collect_etcd():
    result = {
        "url": ETCD_URL,
        "reachable": False,
        "health": False,
        "health_reason": None,
        "latency_ms": None,
        "members": [],
        "expected_members": ETCD_EXPECTED_MEMBERS,
        "single_node_intentional": ETCD_SINGLE_NODE_INTENTIONAL,
        "metrics": {},
        "error": None,
    }
    try:
        health, latency_ms = request(f"{ETCD_URL}/health", as_json=True)
        result["reachable"] = True
        result["health"] = health.get("health") in {True, "true"}
        result["health_reason"] = health.get("reason") or None
        result["latency_ms"] = latency_ms
        metrics_text, _ = request(f"{ETCD_URL}/metrics")
        result["metrics"] = parse_prometheus(metrics_text)
        membership, _ = request(
            f"{ETCD_URL}/v3/cluster/member/list",
            as_json=True,
            method="POST",
            payload={},
        )
        result["members"] = membership.get("members", [])
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
        result["error"] = str(error)
    return result


def execute_action(action):
    action_name = action.get("action")
    nodes = action.get("nodes") or []
    invalid_nodes = [node for node in nodes if node not in PATRONI_NODES]
    if invalid_nodes:
        return 400, {"ok": False, "message": f"Unknown nodes: {', '.join(invalid_nodes)}"}

    if action_name in {"postgres_restart", "reload"}:
        if not nodes:
            return 400, {"ok": False, "message": "Select at least one node"}
        if action_name == "postgres_restart" and len(nodes) >= len(PATRONI_NODES):
            return 409, {"ok": False, "message": "Refusing to restart every PostgreSQL node at once"}
        endpoint = "/restart" if action_name == "postgres_restart" else "/reload"
        results = {node: patroni_action(PATRONI_NODES[node], endpoint) for node in nodes}
        return 200, {"ok": all(result["ok"] for result in results.values()), "results": results}

    if action_name == "switchover":
        leader = action.get("leader")
        candidate = action.get("candidate")
        if leader not in PATRONI_NODES or candidate not in PATRONI_NODES or leader == candidate:
            return 400, {"ok": False, "message": "Valid leader and a different candidate are required"}
        result = patroni_action(PATRONI_NODES[leader], "/switchover", payload={"leader": leader, "candidate": candidate})
        return result["status"], result

    if action_name in {"pause", "resume"}:
        source = None
        for url in PATRONI_NODES.values():
            try:
                request(f"{url}/patroni", as_json=True)
                source = url
                break
            except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
                continue
        if source is None:
            return 503, {"ok": False, "message": "No running Patroni node"}
        result = patroni_action(source, "/config", method="PATCH", payload={"pause": action_name == "pause"})
        return result["status"], result

    return 400, {"ok": False, "message": f"Unsupported action: {action_name}"}


def collect_cluster_details(nodes):
    candidates = [
        node["url"]
        for node in nodes
        if node["reachable"] and node["status"].get("role") in {"primary", "master"}
    ]
    candidates.extend(
        node["url"]
        for node in nodes
        if node["reachable"] and node["url"] not in candidates
    )

    source = None
    topology = {}
    error = None
    for base_url in candidates:
        try:
            topology, _ = request(f"{base_url}/cluster", as_json=True)
            source = base_url
            break
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as caught:
            error = str(caught)

    if source is None:
        return {
            "topology": {},
            "history": [],
            "config": {},
            "source": None,
            "error": error or "No reachable Patroni node",
        }

    def fetch_json(path, fallback):
        try:
            payload, _ = request(f"{source}{path}", as_json=True)
            return payload, None
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as caught:
            return fallback, str(caught)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        history_future = executor.submit(fetch_json, "/history", [])
        config_future = executor.submit(fetch_json, "/config", {})
        history, history_error = history_future.result()
        config, config_error = config_future.result()

    return {
        "topology": topology,
        "history": history,
        "config": config,
        "source": source,
        "error": error,
        "history_error": history_error,
        "config_error": config_error,
    }


def collect_cluster():
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(PATRONI_NODES) + 1) as executor:
        futures = [
            executor.submit(collect_node, name, url)
            for name, url in PATRONI_NODES.items()
        ]
        etcd_future = executor.submit(collect_etcd)
        nodes = [future.result() for future in futures]
        etcd = etcd_future.result()

    nodes.sort(key=lambda node: node["name"])
    cluster = collect_cluster_details(nodes)
    collected_at = time.time()
    replication_lag = replication_lag_snapshot(nodes, cluster, collected_at)
    with LAG_HISTORY_LOCK:
        for name, sample in replication_lag.items():
            LAG_HISTORY[name].append(dict(sample))
        lag_history = {name: list(samples) for name, samples in LAG_HISTORY.items()}

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        write_future = executor.submit(tcp_endpoint, "haproxy", 5000)
        read_future = executor.submit(tcp_endpoint, "haproxy", 5001)
        entrypoints = {"write": write_future.result(), "read": read_future.result()}
    leaders = [
        node["name"]
        for node in nodes
        if node["reachable"] and node["status"].get("role") in {"primary", "master"}
    ]
    replica_backends = [
        node
        for node in nodes
        if node["reachable"] and node["status"].get("role") == "replica"
    ]
    entrypoints["write"]["listener_available"] = entrypoints["write"]["available"]
    entrypoints["read"]["listener_available"] = entrypoints["read"]["available"]
    entrypoints["write"]["available"] = entrypoints["write"]["available"] and len(leaders) == 1
    entrypoints["read"]["available"] = entrypoints["read"]["available"] and bool(replica_backends)
    member_lags = {name: sample.get("replay_lag") for name, sample in replication_lag.items()}
    snapshot = {
        "timestamp": collected_at,
        "leader": leaders[0] if len(leaders) == 1 else None,
        "reachable": sum(node["reachable"] for node in nodes),
        "configured": len(nodes),
        "write_available": entrypoints["write"]["available"],
        "read_available": entrypoints["read"]["available"],
        "lags": member_lags,
        "nodes": {
            node["name"]: {
                "reachable": node["reachable"],
                "role": node["status"].get("role"),
                "state": node["status"].get("state"),
                "timeline": node["status"].get("timeline"),
            }
            for node in nodes
        },
    }
    with STATE_HISTORY_LOCK:
        STATE_HISTORY.append(snapshot)
        state_history = list(STATE_HISTORY)
    return {
        "collected_at": collected_at,
        "summary": {
            "configured": len(nodes),
            "reachable": sum(node["reachable"] for node in nodes),
            "leaders": leaders,
            "scope": cluster["topology"].get("scope")
            or next(
                (
                    node["status"].get("patroni", {}).get("scope")
                    for node in nodes
                    if node["reachable"]
                ),
                None,
            ),
        },
        "cluster": cluster,
        "entrypoints": entrypoints,
        "etcd": etcd,
        "replication_lag": replication_lag,
        "lag_history": lag_history,
        "state_history": state_history,
        "nodes": nodes,
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, message_format, *args):
        print(f'{self.address_string()} - {message_format % args}', flush=True)

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/cluster":
            self.send_json(collect_cluster())
            return
        if self.path == "/health":
            self.send_json({"status": "ok"})
            return
        if self.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/actions":
            self.send_json({"ok": False, "message": "Not found"}, 404)
            return
        if self.headers.get("X-Patroni-Lab") != "control":
            self.send_json({"ok": False, "message": "Missing control header"}, 403)
            return
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 16384)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            status, result = execute_action(payload)
            self.send_json(result, status)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"ok": False, "message": str(error)}, 400)


if __name__ == "__main__":
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), DashboardHandler)
    print(f"Patroni dashboard listening on {LISTEN_HOST}:{LISTEN_PORT}", flush=True)
    server.serve_forever()
