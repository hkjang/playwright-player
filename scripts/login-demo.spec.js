import { expect, test } from "@playwright/test";
import { attachHtml, attachScreenshot } from "./helpers.js";

test("the-internet login accepts known demo credentials", async ({ page }, testInfo) => {
  await page.goto("https://the-internet.herokuapp.com/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Login Page" })).toBeVisible();
  await page.getByLabel("Username").fill("tomsmith");
  await page.getByLabel("Password").fill("SuperSecretPassword!");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("You logged into a secure area!")).toBeVisible();
  await attachScreenshot(page, testInfo, "heroku-login-secure-area");
  await attachHtml(page, testInfo, "heroku-login-dom");
});