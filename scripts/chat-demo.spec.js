import { expect, test } from "@playwright/test";
import { attachHtml, attachScreenshot } from "./helpers.js";

test("chat demo login and send message", async ({ page }, testInfo) => {
  const userName = `CodexE2E-${Date.now()}`;
  const message = `Hello from playwright-player ${Date.now()}`;

  await page.goto("https://demo.chatscope.io/login", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Dismiss" }).click().catch(() => {});

  const nameInput = page.getByRole("textbox", { name: "Your name" });
  await nameInput.click();
  await nameInput.type(userName, { delay: 20 });

  const loginButton = page.getByRole("button", { name: "Login" });
  await expect(loginButton).toBeEnabled();
  await loginButton.click();

  await expect.poll(() => page.url(), { timeout: 20000 }).toMatch(/\/chat$/);
  await expect(page.getByText(userName)).toBeVisible();
  await page.getByText("[Bot] Lilly").click();
  await expect(page.getByText("I'm not really a bot", { exact: false })).toBeVisible();

  const editor = page.locator(".cs-message-input__content-editor");
  await editor.click();
  await editor.type(message, { delay: 10 });
  await editor.press("Enter");
  await expect(page.getByText(message, { exact: true })).toBeVisible();

  await attachScreenshot(page, testInfo, "chat-demo-conversation");
  await attachHtml(page, testInfo, "chat-demo-dom");
});