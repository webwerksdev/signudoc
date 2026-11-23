import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { extractLink, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

const SIGNER_EMAIL = "reese.reload@example.com";
const ANSWER = "One answer before refresh";

test("a signer is asked before a reload throws away what they entered", async ({
  browser,
  page,
}, testInfo) => {
  await test.step("the sender sends a signature and a text field", async () => {
    await signInAsAdministrator(page);

    const pdfPath = await writeSamplePdf(testInfo.outputPath("reload.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Reload before finishing");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill("Reese Reload");
    await page.getByLabel("Signer 1 email").fill(SIGNER_EMAIL);
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);

    const placementTarget = page.getByLabel("Place Signature on page 1");

    await page.getByRole("button", { exact: true, name: "Signature" }).click();

    const box = await placementTarget.boundingBox();

    await placementTarget.click({
      position: { x: box!.width * 0.3, y: box!.height * 0.6 },
    });
    await page.getByRole("button", { exact: true, name: "Text" }).click();
    await page.getByLabel("Place Text on page 1").click({
      position: { x: box!.width * 0.3, y: box!.height * 0.3 },
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

  await test.step("the signer fills both in, tries to reload, and stays", async () => {
    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: SIGNER_EMAIL,
    });
    const signerContext = await browser.newContext({
      viewport: { height: 900, width: 1440 },
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
    await signerPage
      .getByRole("button", { exact: true, name: "Signature" })
      .click();
    await signerPage
      .getByRole("dialog", { name: "Add your signature" })
      .getByRole("button", { name: "Apply signature" })
      .click();
    await signerPage.getByLabel("Enter text").fill(ANSWER);

    const finish = signerPage.getByRole("button", { name: "Finish" });

    await expect(finish).toBeEnabled();

    // The browser asks before leaving; the signer chooses to stay. The
    // question blocks the page, so it is answered as soon as it comes.
    const dialogTypes: string[] = [];

    signerPage.once("dialog", (dialog) => {
      dialogTypes.push(dialog.type());
      void dialog.dismiss();
    });
    await signerPage.evaluate(() => {
      window.location.reload();
    });
    await expect.poll(() => dialogTypes).toEqual(["beforeunload"]);

    await expect(signerPage.getByLabel("Enter text")).toHaveValue(ANSWER);
    await expect(finish).toBeEnabled();

    // Finishing leaves the page with no question asked.
    await finish.click();
    await signerPage
      .getByRole("dialog", { name: "Finish signing?" })
      .getByRole("button", { name: "Finish signing" })
      .click();
    await expect(signerPage).toHaveURL(/\/sign\/[^/]+\/done/);
    await signerContext.close();
  });
});
