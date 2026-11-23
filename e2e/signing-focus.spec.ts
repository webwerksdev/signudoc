import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { extractLink, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

const SIGNER_EMAIL = "fern.focus@example.com";

test("closing the signature dialog puts focus back on the field that opened it", async ({
  browser,
  page,
}, testInfo) => {
  await test.step("the sender sends a signature field", async () => {
    await signInAsAdministrator(page);

    const pdfPath = await writeSamplePdf(testInfo.outputPath("focus.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Keyboard focus");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill("Fern Focus");
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

  await test.step("Escape and Apply both return focus to the field", async () => {
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

    await field.focus();
    await expect(field).toBeFocused();
    await signerPage.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await signerPage.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(field).toBeFocused();

    // The next Tab carries on from the field, not from the top of the page.
    await signerPage.keyboard.press("Tab");
    expect(
      await signerPage.evaluate(
        () => document.activeElement?.closest("header") === null,
      ),
    ).toBe(true);

    await field.focus();
    await signerPage.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "Apply signature" }).click();
    await expect(dialog).toBeHidden();
    await expect(field).toBeFocused();

    await signerContext.close();
  });
});
