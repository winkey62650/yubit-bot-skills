import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:3100";
const browser = await chromium.launch({ channel: "chrome" });

try {
  for (const width of [1440, 1280, 1024, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 } });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator(".kpi-grid").waitFor();
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    assert.ok(dimensions.scrollWidth <= dimensions.clientWidth, `${width}px document overflow: ${JSON.stringify(dimensions)}`);
    assert.ok(dimensions.bodyScrollWidth <= dimensions.clientWidth, `${width}px body overflow: ${JSON.stringify(dimensions)}`);
    await page.close();
  }

  const mobile = await browser.newPage({ viewport: { width: 320, height: 760 } });
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await mobile.locator(".menu-button").click();
  await mobile.getByRole("button", { name: "接入中心" }).click();
  await mobile.locator(".code-box").waitFor();
  assert.match(await mobile.locator(".code-box code").innerText(), /tracker\.js\?site=/);
  await mobile.close();

  console.log("Responsive checks passed at 1440, 1280, 1024, 390 and 320px.");
} finally {
  await browser.close();
}
