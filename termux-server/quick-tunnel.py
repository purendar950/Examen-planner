#!/usr/bin/env python3
"""Run a Cloudflare Quick Tunnel and publish its changing URL to Firestore.

This is the no-domain fallback. The process stays attached to cloudflared; when
cloudflared exits, start-all.sh's existing supervisor restarts this helper, a
new random URL is discovered, health-checked, and atomically written to the
same managed config/turbo registry entry.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

MANAGED_ID = "termux-quick-tunnel"
MANAGED_LABEL = "Phone Quick Tunnel"
RENDER_FALLBACK = {
    "id": "render-primary",
    "label": "Render proxy",
    "url": "https://youtube-turbo-proxy-new.onrender.com",
    "enabled": True,
    "routes": ["media", "ai"],
}
QUICK_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.IGNORECASE)
_STOP_EVENT = threading.Event()
_CLOUDFLARED: subprocess.Popen[str] | None = None
_SIGNAL_NUMBER = 0


def log(message: str) -> None:
    print(f"[quick-tunnel] {message}", flush=True)


def fail(message: str) -> None:
    raise RuntimeError(message)


def parse_roles(raw: str) -> list[str]:
    roles: list[str] = []
    for value in str(raw or "").split(","):
        role = value.strip().lower()
        if role in {"media", "ai"} and role not in roles:
            roles.append(role)
    if not roles:
        fail("QUICK_TUNNEL_ACTIVATE_ROLES must contain media, ai, or both")
    return roles


def normalize_quick_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(str(value or "").strip())
        port = parsed.port
    except ValueError:
        return ""
    hostname = (parsed.hostname or "").lower()
    quick_hostname = re.fullmatch(
        r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com",
        hostname,
        re.IGNORECASE,
    )
    if (
        parsed.scheme != "https"
        or not quick_hostname
        or parsed.username
        or parsed.password
        or port is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        return ""
    return f"https://{hostname}"


def _safe_id(value: Any, fallback: str) -> str:
    normalized = re.sub(r"[^a-z0-9_-]+", "-", str(value or "").strip().lower())
    normalized = normalized.strip("-")
    return normalized or fallback


def _normalized_routes(value: Any) -> list[str]:
    if not isinstance(value, list):
        return ["media", "ai"]
    routes: list[str] = []
    for route in value:
        if route in {"media", "ai"} and route not in routes:
            routes.append(route)
    return routes


def _coerce_server(item: Any, index: int) -> dict[str, Any] | None:
    if isinstance(item, str):
        server: dict[str, Any] = {"url": item}
    elif isinstance(item, dict):
        server = dict(item)
    else:
        return None
    url = str(server.get("url") or "").strip().rstrip("/")
    if not url.startswith(("https://", "http://")):
        return None
    server["id"] = _safe_id(server.get("id"), f"server-{index + 1}")
    server["label"] = str(server.get("label") or server["id"])[:80]
    server["url"] = url
    server["enabled"] = server.get("enabled") is not False
    server["routes"] = _normalized_routes(server.get("routes"))
    return server


def registry_update(
    current: dict[str, Any],
    url: str,
    roles: list[str],
    server_timestamp: Any,
) -> dict[str, Any]:
    """Build a merge-only Firestore update while preserving unrelated config."""
    raw_servers = current.get("backendSplitServers")
    if not isinstance(raw_servers, list) or not raw_servers:
        raw_servers = current.get("backendServers")
    if not isinstance(raw_servers, list) or not raw_servers:
        raw_servers = [RENDER_FALLBACK]

    # Keep each administrator-owned map byte-for-byte equivalent. A normalized
    # view is used only for validation, URL comparisons, and route projection;
    # it is never written over the original record. Legacy string entries need
    # a map representation when promoted into the modern split registry.
    records: list[tuple[dict[str, Any], dict[str, Any]]] = []
    managed_position: int | None = None
    other_urls: set[str] = set()
    for index, item in enumerate(raw_servers):
        view = _coerce_server(item, index)
        if not view:
            fail(f"config/turbo backend registry entry {index + 1} is invalid; fix it before enabling Quick Tunnel")
        is_managed = isinstance(item, dict) and (
            str(item.get("id") or "") == MANAGED_ID
            or str(item.get("managedBy") or "") == "termux-quick-tunnel"
        )
        if is_managed:
            if managed_position is None:
                managed_position = len(records)
            # Collapse only stale copies owned by this helper.
            continue
        preserved = dict(item) if isinstance(item, dict) else view
        other_urls.add(view["url"])
        records.append((preserved, view))

    if len(records) >= 12:
        fail("config/turbo already has 12 non-Quick-Tunnel backend servers; remove one before enabling Quick Tunnel")
    if url in other_urls:
        fail("the new Quick Tunnel URL duplicates another backend registry entry")

    managed = {
        "id": MANAGED_ID,
        "label": MANAGED_LABEL,
        "url": url,
        "enabled": True,
        "routes": list(roles),
        "managedBy": "termux-quick-tunnel",
    }
    managed_record = (managed, managed)
    if managed_position is None:
        records.append(managed_record)
    else:
        records.insert(min(managed_position, len(records)), managed_record)

    servers = [record for record, _view in records]
    media_servers = [record for record, view in records if "media" in view.get("routes", [])]
    update: dict[str, Any] = {
        "backendSplitServers": servers,
        "backendServers": media_servers,
        "backendUpdatedAt": server_timestamp,
        "quickTunnelUrl": url,
        "quickTunnelServerId": MANAGED_ID,
        "quickTunnelUpdatedAt": server_timestamp,
    }
    # Manual mode prefers the phone but preserves Render and other fallbacks.
    if "media" in roles:
        update.update(
            {
                "backendMode": "manual",
                "backendManualServerId": MANAGED_ID,
                "backendMediaMode": "manual",
                "backendMediaServerId": MANAGED_ID,
            }
        )
    if "ai" in roles:
        update.update(
            {
                "backendAiMode": "manual",
                "backendAiServerId": MANAGED_ID,
            }
        )
    return update


def init_firestore() -> tuple[Any, Any]:
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not raw:
        fail("FIREBASE_SERVICE_ACCOUNT is empty; automatic URL publication cannot work")
    try:
        service_account = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"FIREBASE_SERVICE_ACCOUNT is not valid JSON: {exc}")
    for key in ("project_id", "client_email", "private_key"):
        if not service_account.get(key):
            fail(f"FIREBASE_SERVICE_ACCOUNT is missing {key}")

    import firebase_admin
    from firebase_admin import credentials, firestore

    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(service_account))
    return firestore.client(), firestore


def publish_url(db: Any, firestore: Any, url: str, roles: list[str]) -> None:
    ref = db.collection("config").document("turbo")
    transaction = db.transaction()

    @firestore.transactional
    def apply(txn: Any) -> None:
        snapshot = ref.get(transaction=txn)
        current = snapshot.to_dict() if snapshot.exists else {}
        update = registry_update(current or {}, url, roles, firestore.SERVER_TIMESTAMP)
        txn.set(ref, update, merge=True)

    apply(transaction)
    log(f"published {url} to Firestore config/turbo as {MANAGED_ID} ({','.join(roles)})")


def health_payload(url: str, timeout: float = 5.0) -> dict[str, Any] | None:
    request = urllib.request.Request(
        f"{url.rstrip('/')}/health",
        headers={"User-Agent": "ExamZen-Quick-Tunnel/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                return None
            payload = json.loads(response.read(1024 * 1024).decode("utf-8"))
            if not isinstance(payload, dict):
                return None
            # These capability keys identify the ExamZen proxy rather than a
            # generic Cloudflare/HTML response that happened to return 200.
            if "pot_provider" not in payload or "cookie_source" not in payload:
                return None
            return payload
    except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError):
        return None


def wait_for_health(url: str, seconds: int, process: subprocess.Popen[str] | None = None) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and not _STOP_EVENT.is_set():
        if process is not None and process.poll() is not None:
            fail(f"cloudflared exited before {url}/health became ready (code {process.returncode})")
        if health_payload(url):
            return
        time.sleep(2)
    fail(f"{url}/health did not become ready within {seconds}s")


def _read_cloudflared_output(process: subprocess.Popen[str], urls: queue.Queue[str]) -> None:
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="", flush=True)
        for match in QUICK_URL_RE.findall(line):
            normalized = normalize_quick_url(match)
            if normalized:
                urls.put(normalized)


def wait_for_quick_url(
    process: subprocess.Popen[str],
    urls: queue.Queue[str],
    seconds: int,
) -> str:
    deadline = time.monotonic() + seconds
    while not _STOP_EVENT.is_set():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            fail(f"cloudflared did not report a trycloudflare.com URL within {seconds}s")
        try:
            return urls.get(timeout=min(0.25, remaining))
        except queue.Empty:
            if process.poll() is not None:
                fail(f"cloudflared exited before reporting a Quick Tunnel URL (code {process.returncode})")
    fail("stopped while waiting for cloudflared to report a Quick Tunnel URL")


def _handle_signal(signum: int, _frame: Any) -> None:
    global _SIGNAL_NUMBER
    _SIGNAL_NUMBER = signum
    _STOP_EVENT.set()
    process = _CLOUDFLARED
    if process is not None and process.poll() is None:
        process.terminate()


def run(local_url: str, roles: list[str]) -> int:
    global _CLOUDFLARED
    local_root = str(local_url).rstrip("/")
    log(f"waiting for local proxy at {local_root}/health")
    wait_for_health(local_root, int(os.environ.get("QUICK_TUNNEL_LOCAL_TIMEOUT", "90")))

    db, firestore = init_firestore()
    command = [
        os.environ.get("CLOUDFLARED_BIN", "cloudflared"),
        "--no-autoupdate",
        "tunnel",
        "--url",
        local_root,
    ]
    log("starting Cloudflare Quick Tunnel")
    _CLOUDFLARED = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    urls: queue.Queue[str] = queue.Queue()
    reader = threading.Thread(
        target=_read_cloudflared_output,
        args=(_CLOUDFLARED, urls),
        daemon=True,
    )
    reader.start()

    url_timeout = int(os.environ.get("QUICK_TUNNEL_URL_TIMEOUT", "90"))
    quick_url = wait_for_quick_url(_CLOUDFLARED, urls, url_timeout)

    log(f"discovered {quick_url}; waiting for public health")
    wait_for_health(
        quick_url,
        int(os.environ.get("QUICK_TUNNEL_PUBLIC_TIMEOUT", "120")),
        _CLOUDFLARED,
    )
    if _CLOUDFLARED.poll() is not None:
        fail(f"cloudflared exited before the healthy URL could be published (code {_CLOUDFLARED.returncode})")
    publish_url(db, firestore, quick_url, roles)
    log("automatic URL update complete; clients will receive it from Firestore")

    code = _CLOUDFLARED.wait()
    reader.join(timeout=2)
    if _SIGNAL_NUMBER:
        return 128 + _SIGNAL_NUMBER
    return code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-url", default="http://127.0.0.1:8080")
    args = parser.parse_args()
    roles = parse_roles(os.environ.get("QUICK_TUNNEL_ACTIVATE_ROLES", "media,ai"))
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, _handle_signal)
    try:
        return run(args.local_url, roles)
    except Exception as exc:  # noqa: BLE001
        process = _CLOUDFLARED
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        print(f"[quick-tunnel] ERROR: {exc}", file=sys.stderr, flush=True)
        if _SIGNAL_NUMBER:
            return 128 + _SIGNAL_NUMBER
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
