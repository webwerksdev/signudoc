import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

test("on a short phone the Field tools sheet keeps Done in view, and Escape closes it", async ({
  page,
}, testInfo) => {
  await signInAsAdministrator(page);

  const pdfPath = await writeSamplePdf(testInfo.outputPath("tools.pdf"));

  await page.goto("/envelopes/new");
  await page.getByLabel("Envelope title").fill("Field tools on a phone");
  await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
  await page.getByRole("button", { name: "Next ->" }).click();
  await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

  await page.getByLabel("Signer 1 name").fill("Robin Phone");
  await page.getByLabel("Signer 1 email").fill("robin.phone@example.com");
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page).toHaveURL(/\/prepare$/);
  await expect(
    page.getByRole("img", { name: "Rendered PDF page 1" }),
  ).toBeVisible();

  // A short, narrow phone screen, as in the report.
  await page.setViewportSize({ height: 500, width: 390 });

  const openTools = page.getByRole("button", { name: "Open field tools" });
  const sheet = page.getByRole("dialog", { name: "Field tools" });
  const done = sheet.getByRole("button", { exact: true, name: "Done" });

  // Choose a tool first, so the test can see that closing the sheet
  // keeps it chosen.
  await openTools.click();
  await sheet.getByRole("button", { exact: true, name: "Signature" }).click();
  await expect(sheet).toBeHidden();

  await openTools.click();
  await expect(sheet).toBeVisible();
  // Opening the sheet moves focus into it.
  await expect
    .poll(() =>
      sheet.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);

  // The whole sheet, and its Done button, fit on the screen.
  const sheetBox = await sheet.boundingBox();
  const doneBox = await done.boundingBox();

  expect(sheetBox).not.toBeNull();
  expect(doneBox).not.toBeNull();
  expect(sheetBox!.y).toBeGreaterThanOrEqual(0);
  expect(doneBox!.y).toBeGreaterThanOrEqual(0);
  expect(doneBox!.y + doneBox!.height).toBeLessThanOrEqual(500);

  // The tools below the fold can still be reached, by scrolling the sheet.
  await sheet
    .getByRole("button", { exact: true, name: "Dropdown" })
    .scrollIntoViewIfNeeded();
  await expect(
    sheet.getByRole("button", { exact: true, name: "Dropdown" }),
  ).toBeInViewport();
  await expect(done).toBeInViewport();

  await done.click();
  await expect(sheet).toBeHidden();
  await expect(openTools).toBeFocused();

  await openTools.click();
  await expect(sheet).toBeVisible();
  // Done and Escape close the sheet without changing the chosen tool.
  await expect(
    sheet.getByRole("button", { exact: true, name: "Signature" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(openTools).toBeFocused();

  // On a taller phone, choosing another tool still starts placing it.
  await page.setViewportSize({ height: 844, width: 390 });
  await openTools.click();
  await expect(
    sheet.getByRole("button", { exact: true, name: "Signature" }),
  ).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { exact: true, name: "Date" }).click();
  await expect(sheet).toBeHidden();
  await openTools.click();
  await expect(
    sheet.getByRole("button", { exact: true, name: "Date" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    sheet.getByRole("button", { exact: true, name: "Signature" }),
  ).toHaveAttribute("aria-pressed", "false");
  await done.click();
  await expect(openTools).toBeFocused();

  // Growing the window to the desktop layout, which hides the sheet, closes
  // it, so it no longer holds Tab or Escape.
  await openTools.click();
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.setViewportSize({ height: 844, width: 390 });
  await expect(sheet).toBeHidden();
});
