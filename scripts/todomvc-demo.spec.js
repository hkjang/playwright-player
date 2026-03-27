import { expect, test } from "@playwright/test";
import { attachHtml, attachScreenshot } from "./helpers.js";

test("todomvc demo supports add and complete", async ({ page }, testInfo) => {
  await page.goto("https://demo.playwright.dev/todomvc/#/", { waitUntil: "domcontentloaded" });
  const input = page.getByPlaceholder("What needs to be done?");
  await expect(input).toBeVisible();
  await input.fill("Review screenshot reporting");
  await input.press("Enter");
  await input.fill("Verify MCP run");
  await input.press("Enter");
  await expect(page.getByTestId("todo-title")).toHaveCount(2);
  await page.getByTestId("todo-item").nth(0).getByRole("checkbox").check();
  await expect(page.getByText("1 item left")).toBeVisible();
  await attachScreenshot(page, testInfo, "todomvc-state");
  await attachHtml(page, testInfo, "todomvc-dom");
});