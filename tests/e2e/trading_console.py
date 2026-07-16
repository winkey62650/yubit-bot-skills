#!/usr/bin/env python3
"""Read-only browser acceptance test for the trading console.

The test intentionally avoids submitting any trading configuration. Login
credentials are read from the process environment, then from local ignored
.env files. Their values are never printed or written to screenshots.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:3000").rstrip("/")
SCREENSHOT = Path(os.environ.get("E2E_SCREENSHOT", "/tmp/trading-console-1366x768.png"))
VERCEL_BYPASS_SECRET = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "").strip()


def local_env() -> dict[str, str]:
    values: dict[str, str] = {}
    for filename in (".env", ".env.local"):
        path = ROOT / filename
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            values[key] = value
    return values


def credentials() -> tuple[str, str]:
    values = local_env()
    username = os.environ.get("AUTH_USERNAME") or values.get("AUTH_USERNAME")
    password = os.environ.get("AUTH_PASSWORD") or values.get("AUTH_PASSWORD")
    if not username or not password:
        raise RuntimeError("AUTH_USERNAME and AUTH_PASSWORD are required for browser acceptance")
    return username, password


def main() -> None:
    username, password = credentials()
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_responses: list[dict[str, object]] = []
    result: dict[str, object] = {
        "viewport": "1366x768",
        "tabs": [],
        "screenshot": str(SCREENSHOT),
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        context_options: dict[str, object] = {"viewport": {"width": 1366, "height": 768}}
        if VERCEL_BYPASS_SECRET:
            context_options["extra_http_headers"] = {
                "x-vercel-protection-bypass": VERCEL_BYPASS_SECRET,
                "x-vercel-set-bypass-cookie": "true",
            }
        context = browser.new_context(**context_options)
        page = context.new_page()
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "response",
            lambda response: failed_responses.append(
                {"status": response.status, "url": response.url}
            )
            if response.status >= 400
            else None,
        )

        page.goto(f"{BASE_URL}/trading", wait_until="domcontentloaded")
        page.wait_for_url("**/login")

        # Browser-native required-field validation must prevent empty submission.
        page.get_by_role("button", name="登录后台").click()
        validation_message = page.get_by_label("账号").evaluate(
            "element => element.validationMessage"
        )
        assert validation_message, "empty login form did not expose required-field validation"
        assert page.url.endswith("/login"), "empty login form unexpectedly navigated"

        page.get_by_label("账号").fill(username)
        page.get_by_label("密码").fill(password)
        page.get_by_role("button", name="登录后台").click()
        page.wait_for_url("**/group-config")

        page.goto(f"{BASE_URL}/trading", wait_until="domcontentloaded")
        if page.url.endswith("/login"):
            cookie_details = [
                {
                    "name": cookie["name"],
                    "domain": cookie["domain"],
                    "path": cookie["path"],
                    "secure": cookie["secure"],
                    "expires": cookie["expires"],
                }
                for cookie in context.cookies()
            ]
            raise AssertionError(
                f"authenticated session was rejected on /trading; cookies={cookie_details}"
            )
        page.get_by_role("heading", name="交易中心").wait_for()
        page.get_by_text("正在读取交易中心…").wait_for(state="detached")
        assert page.get_by_text("读取失败：").count() == 0, "trading console failed to load"

        tab_expectations = {
            "交易日志": "订单号来自 Trader",
            "Trader 管理": "新增 Trader",
            "发布目标": "新增发布目标",
            "系统状态": "SpeakerBot 接收入口",
        }
        for tab_name, expected_text in tab_expectations.items():
            tab = page.get_by_role("tab", name=tab_name)
            tab.click()
            page.get_by_text(expected_text, exact=False).first.wait_for()
            assert tab.get_attribute("aria-selected") == "true", f"{tab_name} was not selected"
            result["tabs"].append(tab_name)

        page_size = page.evaluate(
            """() => ({
              viewportWidth: window.innerWidth,
              documentWidth: document.documentElement.scrollWidth
            })"""
        )
        assert page_size["documentWidth"] <= page_size["viewportWidth"] + 1, (
            "page has horizontal overflow at 1366px: "
            f"{page_size['documentWidth']} > {page_size['viewportWidth']}"
        )

        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SCREENSHOT), full_page=True)
        browser.close()

    assert not page_errors, f"uncaught browser errors: {page_errors}"
    assert not failed_responses, f"failed network responses: {failed_responses}"
    unexpected_console_errors = [
        message
        for message in console_errors
        if "Failed to load resource: the server responded with a status of 404" not in message
    ]
    assert not unexpected_console_errors, f"browser console errors: {unexpected_console_errors}"
    result["status"] = "passed"
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
