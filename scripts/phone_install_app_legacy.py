#!/usr/bin/env python3
"""Legacy Gateway-side app installer for Honor App Market.

This is a bridge until the Android APK provides native android_install_app.
It still uses primitive actions through the Gateway, but centralizes retries,
UI-tree parsing, overlay dismissal, and completion verification.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PHONE_EXECUTE = SCRIPT_DIR / "phone_execute.py"

APP_MARKET_ICON_CENTER = (741, 1705)  # observed launcher bounds [600,1541,882,1870]
SEARCH_FIELD_CENTER = (550, 221)
SEARCH_BUTTON_CENTER = (1024, 221)
CLEAR_BUTTON_CENTER = (857, 221)
HONOR_SKIP_CENTER = (348, 2463)


def run_action(action, arguments=None, timeout_ms=None):
    cmd = [sys.executable, str(PHONE_EXECUTE), action, json.dumps(arguments or {}, ensure_ascii=False)]
    if timeout_ms is not None:
        cmd.extend(["--timeout-ms", str(timeout_ms)])
    env = os.environ.copy()
    # Keep stdout machine-readable; phone_execute itself prints JSON only.
    proc = subprocess.run(cmd, text=True, capture_output=True, env=env, timeout=max((timeout_ms or 120000) / 1000 + 30, 60))
    if proc.returncode != 0:
        raise RuntimeError(f"{action} failed\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return json.loads(proc.stdout)


def extract_ui_payload(result):
    try:
        text = result["mcp"]["result"]["content"][0]["text"]
        return json.loads(text)
    except Exception as exc:
        raise RuntimeError(f"cannot parse UI tree result: {exc}; result={json.dumps(result, ensure_ascii=False)[:1000]}")


def get_ui():
    return extract_ui_payload(run_action("get_ui_tree", {}, timeout_ms=30000))


def center(bounds):
    x1, y1, x2, y2 = bounds
    return (x1 + x2) // 2, (y1 + y2) // 2


def parse_bounds(s):
    return [int(x) for x in re.findall(r"-?\d+", s)]


def parse_elements(ui):
    elements = []
    raw = ui.get("elements", "")
    for line in raw.splitlines():
        if not line or line.startswith("IDX |"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 6:
            continue
        try:
            idx = int(parts[0])
        except ValueError:
            continue
        elements.append({
            "idx": idx,
            "resource_id": parts[1],
            "text": parts[2],
            "desc": parts[3],
            "flags": parts[4],
            "bounds": parse_bounds(parts[5]),
            "raw": line,
        })
    return elements


def tap_xy(x, y):
    return run_action("tap", {"x": int(x), "y": int(y)}, timeout_ms=30000)


def type_text(text):
    return run_action("type", {"text": text}, timeout_ms=30000)


def press_back():
    return run_action("back", {}, timeout_ms=30000)


def maybe_dismiss_overlay(ui=None):
    ui = ui or get_ui()
    app = ui.get("app", "")
    raw = ui.get("elements", "")
    if app == "com.hihonor.hndockbar" or "荣耀任意门" in raw:
        tap_xy(*HONOR_SKIP_CENTER)
        time.sleep(1)
        return True
    for element in parse_elements(ui):
        if element["text"] in {"跳过", "稍后", "取消", "知道了", "关闭", "暂不"}:
            tap_xy(*center(element["bounds"]))
            time.sleep(1)
            return True
    return False


def ensure_app_market_open():
    ui = get_ui()
    if maybe_dismiss_overlay(ui):
        ui = get_ui()
    if ui.get("app") == "com.hihonor.appmarket":
        return ui
    # If on launcher, use observed App Market icon. Otherwise go home then tap it.
    if ui.get("app") != "com.hihonor.android.launcher":
        run_action("home", {}, timeout_ms=30000)
        time.sleep(1)
    tap_xy(*APP_MARKET_ICON_CENTER)
    time.sleep(3)
    ui = get_ui()
    maybe_dismiss_overlay(ui)
    ui = get_ui()
    if ui.get("app") != "com.hihonor.appmarket":
        raise RuntimeError(f"failed to open Honor App Market, foreground={ui.get('app')}")
    return ui


def clear_and_search(app_name):
    ui = ensure_app_market_open()
    maybe_dismiss_overlay(ui)
    # If search field is visible, clear old value. If not, tap search entry or search icon area.
    raw = ui.get("elements", "")
    if "com.hihonor.appmarket:id/et_search_content" in raw or "com.hihonor.appmarket:id/iv_search_clear" in raw:
        tap_xy(*CLEAR_BUTTON_CENTER)
        time.sleep(0.5)
        tap_xy(*SEARCH_FIELD_CENTER)
    else:
        # App market home may have a search box near top; tapping the top search area enters search mode.
        tap_xy(600, 200)
        time.sleep(1)
        tap_xy(*CLEAR_BUTTON_CENTER)
        tap_xy(*SEARCH_FIELD_CENTER)
    type_text(app_name)
    time.sleep(0.5)
    tap_xy(*SEARCH_BUTTON_CENTER)
    time.sleep(3)


def find_target_row(ui, app_name):
    elements = parse_elements(ui)
    name_elements = [e for e in elements if e["resource_id"] == "com.hihonor.appmarket:id/zy_app_name_txt" and e["text"] == app_name]
    buttons = [e for e in elements if e["resource_id"] == "com.hihonor.appmarket:id/zy_state_app_btn"]
    for name in name_elements:
        n_top, n_bottom = name["bounds"][1], name["bounds"][3]
        candidates = []
        for button in buttons:
            b_top, b_bottom = button["bounds"][1], button["bounds"][3]
            # Same result row: vertical centers reasonably close.
            if abs(((b_top + b_bottom) / 2) - ((n_top + n_bottom) / 2)) < 180:
                candidates.append(button)
        if candidates:
            candidates.sort(key=lambda b: abs(center(b["bounds"])[1] - center(name["bounds"])[1]))
            return name, candidates[0]
    return None, None


def install_app(app_name, timeout_s=180):
    clear_and_search(app_name)
    deadline = time.time() + timeout_s
    last_ui = None
    install_clicked = False
    while time.time() < deadline:
        ui = get_ui()
        last_ui = ui
        if maybe_dismiss_overlay(ui):
            continue
        if ui.get("app") != "com.hihonor.appmarket":
            ensure_app_market_open()
            continue
        name, button = find_target_row(ui, app_name)
        if not name:
            time.sleep(1)
            continue
        state = button["text"] or button["desc"]
        bx, by = center(button["bounds"])
        if "打开" in state:
            return {
                "status": "ok",
                "app_name": app_name,
                "installed": True,
                "final_state": "open_button_visible",
                "button": state,
                "matched_row": name["raw"],
            }
        if any(token in state for token in ["安装", "继续"]):
            if not install_clicked:
                tap_xy(bx, by)
                install_clicked = True
                time.sleep(5)
                continue
        # Percent/progress/pause states, wait and re-check.
        time.sleep(2)
    return {
        "status": "error",
        "error_code": "install_timeout",
        "message": f"Timed out waiting for {app_name} to become installed/open",
        "last_ui": last_ui,
    }


def main():
    parser = argparse.ArgumentParser(description="Install an app from Honor App Market using current primitive Gateway actions.")
    parser.add_argument("app_name")
    parser.add_argument("--timeout-s", type=int, default=180)
    args = parser.parse_args()
    result = install_app(args.app_name, timeout_s=args.timeout_s)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("status") != "ok":
        sys.exit(1)


if __name__ == "__main__":
    main()
