#!/usr/bin/env python3
"""Phone Executor Gateway CLI.

Queues one Gateway action, auto-approves confirmation when requested, waits for the
real queued task result, and prints JSON. Token is read from env or the gateway env
file; no secret is stored in this script.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = "http://localhost:8787"
DEFAULT_DEVICE_ID = "your-device-id"
DEFAULT_ENV_FILE = "gateway.env"
TERMINAL_STATUSES = {"completed", "failed", "canceled"}


def load_client_token(env_file: str) -> str:
    token = os.environ.get("PHONE_EXECUTOR_CLIENT_TOKEN", "").strip()
    if token:
        return token
    try:
        raw = open(env_file, encoding="utf-8").read()
    except OSError as exc:
        raise SystemExit(
            f"Cannot read client token. Set PHONE_EXECUTOR_CLIENT_TOKEN or run with access to {env_file}: {exc}"
        )
    match = re.search(r"^PHONE_EXECUTOR_CLIENT_TOKEN=(.+)$", raw, re.M)
    if not match:
        raise SystemExit(f"PHONE_EXECUTOR_CLIENT_TOKEN not found in {env_file}")
    return match.group(1).strip().strip('"\'')


class GatewayClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(self, method: str, path: str, body=None, timeout=30):
        data = None
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                text = resp.read().decode("utf-8", "replace")
                return resp.status, json.loads(text) if text else None
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                parsed = {"raw": text}
            return exc.code, parsed

    def execute(self, device_id: str, action: str, arguments: dict, *, timeout_ms=None, auto_approve=True, reason=None):
        payload = {"device_id": device_id, "action": action, "arguments": arguments or {}}
        if timeout_ms is not None:
            payload["timeout_ms"] = timeout_ms
        status, body = self.request("POST", "/execute", payload)
        if status >= 400:
            raise RuntimeError(f"execute failed: HTTP {status} {json.dumps(body, ensure_ascii=False)}")

        confirmation = None
        if body.get("status") == "confirmation_required":
            confirmation = body
            if not auto_approve:
                return {"confirmation_required": body}
            status, approved = self.request("POST", "/task/confirm", {
                "confirmation_id": body["confirmation_id"],
                "approve": True,
                "reason": reason or f"auto-approved by phone_execute.py for action={action}",
            })
            if status >= 400:
                raise RuntimeError(f"confirm failed: HTTP {status} {json.dumps(approved, ensure_ascii=False)}")
            body = approved.get("queued") or approved

        result = self.wait_result(body, timeout_ms=timeout_ms)
        if confirmation:
            result.setdefault("confirmation", confirmation)
        return result

    def wait_result(self, queued: dict, timeout_ms=None):
        task_id = queued.get("task_id")
        step_id = queued.get("step_id")
        if not task_id or not step_id:
            return queued
        qs = urllib.parse.urlencode({"task_id": task_id, "step_id": step_id})
        deadline = time.time() + max((timeout_ms or 120_000) / 1000.0, 30)
        last_status = None
        last_result = None
        while time.time() < deadline:
            status, body = self.request("GET", f"/task/status?{qs}", timeout=15)
            if status < 400 and isinstance(body, dict):
                last_status = body
            status, result = self.request("GET", f"/task/result?{qs}", timeout=15)
            if status < 400:
                return result
            last_result = result
            if isinstance(last_status, dict) and last_status.get("status") in {"failed", "canceled"}:
                break
            time.sleep(0.5)
        raise RuntimeError(
            "result unavailable before timeout: "
            f"last_status={json.dumps(last_status, ensure_ascii=False)} "
            f"last_result={json.dumps(last_result, ensure_ascii=False)}"
        )


def main():
    parser = argparse.ArgumentParser(description="Execute one Phone Executor Gateway action and wait for result.")
    parser.add_argument("action")
    parser.add_argument("arguments", nargs="?", default="{}", help="JSON object arguments")
    parser.add_argument("--device-id", default=os.environ.get("PHONE_EXECUTOR_DEVICE_ID", DEFAULT_DEVICE_ID))
    parser.add_argument("--base-url", default=os.environ.get("PHONE_EXECUTOR_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--env-file", default=os.environ.get("PHONE_EXECUTOR_ENV_FILE", DEFAULT_ENV_FILE))
    parser.add_argument("--timeout-ms", type=int, default=None)
    parser.add_argument("--no-auto-approve", action="store_true")
    parser.add_argument("--reason", default=None)
    args = parser.parse_args()

    try:
        arguments = json.loads(args.arguments)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"arguments must be JSON: {exc}")
    if not isinstance(arguments, dict):
        raise SystemExit("arguments must decode to a JSON object")

    client = GatewayClient(args.base_url, load_client_token(args.env_file))
    result = client.execute(
        args.device_id,
        args.action,
        arguments,
        timeout_ms=args.timeout_ms,
        auto_approve=not args.no_auto_approve,
        reason=args.reason,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
