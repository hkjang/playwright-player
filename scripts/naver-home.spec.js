import { expect, test } from "@playwright/test";
import { attachHtml, attachScreenshot } from "./helpers.js";

test("naver home renders search and news", async ({ page }, testInfo) => {
  await page.goto("https://www.naver.com", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle(/NAVER/i);
  await expect(page.locator("input[name='query']")).toBeVisible();
  await expect(page.locator("#newsstand")).toBeVisible();
  await attachScreenshot(page, testInfo, "naver-home");
  await attachHtml(page, testInfo, "naver-home-dom");
});