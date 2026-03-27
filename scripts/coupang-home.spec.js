import { expect, test } from "@playwright/test";
import { attachHtml, attachScreenshot } from "./helpers.js";

test("coupang home is reachable from a headless container", async ({ page }, testInfo) => {
  await page.goto("https://www.coupang.com", { waitUntil: "domcontentloaded" });

  const title = await page.title();
  const blocked = /access denied/i.test(title) || await page.locator("text=Access Denied").count();
  if (blocked) {
    await attachScreenshot(page, testInfo, "coupang-access-denied");
    await attachHtml(page, testInfo, "coupang-access-denied-dom");
    throw new Error(`Coupang blocked automated headless access: ${title}`);
  }

  await expect(page.locator("input[type='search'], input[name='q']").first()).toBeVisible();
  await attachScreenshot(page, testInfo, "coupang-home");
  await attachHtml(page, testInfo, "coupang-home-dom");
});
