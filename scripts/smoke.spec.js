import { expect, test } from "@playwright/test";

test("offline smoke page", async ({ page }) => {
  await page.goto("data:text/html,<html><body><h1>Hello</h1><button aria-label='Login'>Login</button></body></html>");
  await expect(page.getByRole("heading", { name: "Hello" })).toBeVisible();
  await page.getByRole("button", { name: "Login" }).click();
});