#!/usr/bin/env python3
"""Browser acceptance test for collapsible community navigation."""

from __future__ import annotations

import json
import os

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("E2E_BASE_URL", "http://127.0.0.1:3000").rstrip("/")


def credentials() -> tuple[str, str]:
    username = os.environ.get("AUTH_USERNAME")
    password = os.environ.get("AUTH_PASSWORD")
    if not username or not password:
        raise RuntimeError("AUTH_USERNAME and AUTH_PASSWORD are required")
    return username, password


def assert_panel_state(page, section: str, expanded: bool) -> None:
    button = page.locator(f'button[aria-controls="console-navigation-{section}"]')
    panel = page.locator(f"#console-navigation-{section}")
    assert button.get_attribute("aria-expanded") == str(expanded).lower()
    display = panel.evaluate("element => getComputedStyle(element).display")
    if expanded:
        assert display != "none", f"{section} navigation remained hidden"
    else:
        assert display == "none", f"{section} navigation remained visible: {display}"


def main() -> None:
    username, password = credentials()
    checked: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(viewport={"width": 1366, "height": 768})
        page = context.new_page()

        page.goto(f"{BASE_URL}/group-config", wait_until="domcontentloaded")
        if page.url.endswith("/login"):
            page.locator('input[autocomplete="username"]').fill(username)
            page.locator('input[autocomplete="current-password"]').fill(password)
            page.locator('button[type="submit"]').click()
            page.wait_for_url("**/group-config")

        for section in ("telegram", "discord"):
            button = page.locator(f'button[aria-controls="console-navigation-{section}"]')
            button.wait_for(state="visible")
            assert_panel_state(page, section, True)
            button.click()
            assert_panel_state(page, section, False)

            page.reload(wait_until="domcontentloaded")
            assert_panel_state(page, section, False)
            page.locator(f'button[aria-controls="console-navigation-{section}"]').click()
            assert_panel_state(page, section, True)
            checked.append(section)

        browser.close()

    print(json.dumps({"status": "passed", "checked": checked, "viewport": "1366x768"}))


if __name__ == "__main__":
    main()
