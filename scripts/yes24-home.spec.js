import { expect, test } from "@playwright/test";
import { attachHtml, attachScreenshot } from "./helpers.js";

test("yes24 home renders search and bestseller entry", async ({ page }, testInfo) => {
  await page.goto("https://www.yes24.com", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#query")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("a[href*='daybestseller']").first()).toBeVisible({ timeout: 15000 });
  await attachScreenshot(page, testInfo, "yes24-home");
  await attachHtml(page, testInfo, "yes24-home-dom");
});
