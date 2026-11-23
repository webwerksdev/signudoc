import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

// 120 letters with no space: a title the form accepts, and one word the
// confirmation dialog has to break.
const LONG_TITLE = "W".repeat(120);

for (const width of [1440, 1024]) {
  test(`a long unbroken title keeps Send now on screen at ${String(width)} px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ height: 850, width });
    await signInAsAdministrator(page);

    const pdfPath = await writeSamplePdf(testInfo.outputPath("long.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill(LONG_TITLE);
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill("Wren Wide");
    await page.getByLabel("Signer 1 email").fill("wren.wide@example.com");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);

    await page.getByRole("button", { exact: true, name: "Signature" }).click();

    const placementTarget = page.getByLabel("Place Signature on page 1");
    const box = await placementTarget.boundingBox();

    await placementTarget.click({
      position: { x: box!.width * 0.3, y: box!.height * 0.6 },
    });
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/review$/);
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await confirmation.getByRole("checkbox").check();

    const dialogBox = await confirmation.boundingBox();
    const sendNow = confirmation.getByRole("button", { name: "Send now" });
    const sendBox = await sendNow.boundingBox();

    // The dialog and its button stay inside the window, and the whole
    // title is inside the dialog.
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width);
    expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(width);
    expect(
      await confirmation.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await expect(confirmation).toContainText(LONG_TITLE);
    await sendNow.click({ trial: true });
  });
}
