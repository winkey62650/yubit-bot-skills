import json
import os
from pathlib import Path
from urllib.parse import urlparse

import requests

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:3000")
ROUTES = [
    "/distribution?view=site-analytics",
    "/distribution?view=automation",
    "/composer",
    "/group-config",
    "/new-group",
    "/discord",
    "/trading",
    "/telegram-user-authorization",
    "/bots",
    "/settings",
]


def load_local_auth():
    values = {}
    for line in Path(".env.auth.local").read_text().splitlines():
        if line and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values["AUTH_USERNAME"], values["AUTH_PASSWORD"]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    username, password = load_local_auth()
    login = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"username": username, "password": password},
        timeout=10,
    )
    login.raise_for_status()
    session = login.cookies["yubit_session"]
    host = urlparse(BASE_URL).hostname
    context = browser.new_context(viewport={"width": 1366, "height": 768})
    context.add_cookies([{
        "name": "yubit_session",
        "value": session,
        "domain": host,
        "path": "/",
        "httpOnly": True,
        "secure": urlparse(BASE_URL).scheme == "https",
        "sameSite": "Lax",
    }])
    page = context.new_page()
    page.goto(f"{BASE_URL}/group-config", wait_until="domcontentloaded", timeout=15_000)
    page.wait_for_timeout(750)

    toggle = page.get_by_role("button", name="Switch to English").first
    toggle.click()
    page.wait_for_function("document.documentElement.lang === 'en'")

    report = []
    for route in ROUTES:
        print(f"Scanning {route}", flush=True)
        page.goto(f"{BASE_URL}{route}", wait_until="domcontentloaded", timeout=15_000)
        page.wait_for_timeout(750)
        print(f"  Loaded {page.url}", flush=True)
        page.wait_for_timeout(750)
        chinese = page.evaluate(
            """() => {
              const values = [];
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const node = walker.currentNode;
                const parent = node.parentElement;
                if (!parent || parent.closest('script, style, noscript, [data-i18n-skip]')) continue;
                const style = getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                const value = node.data.trim();
                if (/[\\u3400-\\u9fff]/.test(value)) values.push(value);
              }
              return [...new Set(values)];
            }"""
        )
        unexpected = [value for value in chinese if value != "中文"]
        report.append({"route": route, "chinese": unexpected})

    print(json.dumps(report, ensure_ascii=False, indent=2))
    failures = [item for item in report if item["chinese"]]
    assert not failures, f"Chinese UI copy remains in English mode: {failures}"

    page.goto(f"{BASE_URL}/group-config", wait_until="domcontentloaded", timeout=15_000)
    page.wait_for_timeout(750)
    assert page.evaluate("document.documentElement.lang") == "en"
    page.locator("button:visible", has_text="中文").first.click()
    page.wait_for_function("document.documentElement.lang === 'zh-CN'")
    assert page.get_by_text("群与 Topic", exact=True).first.is_visible()
    browser.close()
