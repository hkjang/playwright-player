import fs from "node:fs/promises";

export async function attachScreenshot(page, testInfo, name) {
  const filePath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  await testInfo.attach(name, {
    path: filePath,
    contentType: "image/png",
  });
  return filePath;
}

export async function attachHtml(page, testInfo, name) {
  const filePath = testInfo.outputPath(`${name}.html`);
  await fs.writeFile(filePath, await page.content(), "utf8");
  await testInfo.attach(name, {
    path: filePath,
    contentType: "text/html",
  });
  return filePath;
}