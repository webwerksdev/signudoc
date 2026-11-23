import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { extractLink, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

const SIGNER_EMAIL = "wren.wide@example.com";

test("a long typed signature keeps the signature dialog's buttons on a phone screen", async ({
  browser,
  page,
}, testInfo) => {
  await test.step("the sender sends a signature field", async () => {
    await signInAsAdministrator(page);

    const pdfPath = await writeSamplePdf(
      testInfo.outputPath("long-signature.pdf"),
    );

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Long typed signature");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill("Wren Wide");
    await page.getByLabel("Signer 1 email").fill(SIGNER_EMAIL);
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);

    const placementTarget = page.getByLabel("Place Signature on page 1");

    await page.getByRole("button", { exact: true, name: "Signature" }).click();

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
    await confirmation.getByRole("button", { name: "Send now" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+$/);
  });

  await test.step("an 80-character typed signature stays inside the dialog", async () => {
    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: SIGNER_EMAIL,
    });
    const signerContext = await browser.newContext({
      viewport: { height: 844, width: 390 },
    });
    const signerPage = await signerContext.newPage();

    await signerPage.goto(extractLink(invitation.text, "/sign/"));

    const consent = signerPage.getByRole("dialog", { name: "Before you sign" });

    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
    await expect(consent).toBeHidden();

    const field = signerPage.getByRole("button", {
      exact: true,
      name: "Signature",
    });
    const dialog = signerPage.getByRole("dialog", {
      name: "Add your signature",
    });

    await field.click();
    await expect(dialog).toBeVisible();

    const typed = dialog.getByLabel("Type signature");
    const longName = "W".repeat(80);

    await typed.fill(longName);
    await expect(typed).toHaveValue(longName);

    // Nothing in the dialog is wider than the dialog, so it never scrolls
    // sideways and every label stays on the 390 px screen.
    const widths = await dialog.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));

    expect(widths.scroll).toBeLessThanOrEqual(widths.client);

    for (const control of [
      dialog.getByRole("tab", { name: "Type" }),
      dialog.getByRole("tab", { name: "Draw" }),
      dialog.getByRole("button", { name: "Apply signature" }),
      dialog.getByRole("button", { name: "Cancel" }),
    ]) {
      const box = await control.boundingBox();

      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }

    // The whole value is still applied.
    await dialog.getByRole("button", { name: "Apply signature" }).click();
    await expect(dialog).toBeHidden();

    await signerContext.close();
  });
});
