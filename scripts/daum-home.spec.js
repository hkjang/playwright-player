import { expect, test } from "@playwright/test";
import { attachHtml, attachScreenshot } from "./helpers.js";

test("daum home renders search and news", async ({ page }, testInfo) => {
  await page.goto("https://www.daum.net", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle(/Daum/i);
  await expect(page.locator("input[name='q']")).toBeVisible();
  await expect(page.locator("a[href*='v.daum.net']").first()).toBeVisible();
  await attachScreenshot(page, testInfo, "daum-home");
  await attachHtml(page, testInfo, "daum-home-dom");
});