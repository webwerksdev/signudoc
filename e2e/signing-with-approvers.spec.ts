import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { extractLink, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator. A signer signs, then an approver approves and that
// finishes the envelope.

const SIGNER = { email: "sam.signer@example.com", name: "Sam Signer" };
const APPROVER = { email: "alex.approver@example.com", name: "Alex Approver" };

test("an approver approves after the signer, and that finishes the envelope", async ({
  browser,
  page,
}, testInfo) => {
  await test.step("the sender adds a signer and an approver", async () => {
    await signInAsAdministrator(page);

    const pdfPath = await writeSamplePdf(testInfo.outputPath("approval.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Needs an approval");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill(SIGNER.name);
    await page.getByLabel("Signer 1 email").fill(SIGNER.email);
    await page.getByRole("button", { name: "+ Add another signer" }).click();
    await page.getByLabel("Signer 2 name").fill(APPROVER.name);
    await page.getByLabel("Signer 2 email").fill(APPROVER.email);
    await page.getByLabel("Signer 2 role").selectOption("approver");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);

    // Only the signer gets fields; the approver is not offered.
    await expect(
      page.getByRole("button", { name: /Alex Approver \d+ fields? placed/ }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: /Sam Signer \d+ fields? placed/ })
      .click();
    await page.getByRole("button", { exact: true, name: "Signature" }).click();

    const placementTarget = page.getByLabel("Place Signature on page 1");
    const box = await placementTarget.boundingBox();

    await placementTarget.click({
      position: { x: box!.width * 0.3, y: box!.height * 0.3 },
    });
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/review$/);
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await expect(confirmation).toContainText(
      "will be sent to 1 signer and 1 approver.",
    );
    await expect(confirmation).toContainText(
      "The first person (Sam Signer) will be notified immediately.",
    );
    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "Send now" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+$/);
  });

  await test.step("the signer signs", async () => {
    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: SIGNER.email,
    });
    const context = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const signerPage = await context.newPage();

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
    await signerPage.getByRole("button", { name: "Finish" }).click();
    await signerPage
      .getByRole("dialog", { name: "Finish signing?" })
      .getByRole("button", { name: "Finish signing" })
      .click();
    await expect(signerPage).toHaveURL(/\/sign\/[^/]+\/done/);
    await context.close();
  });

  await test.step("the approver approves, which completes it", async () => {
    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: APPROVER.email,
    });
    const context = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const approverPage = await context.newPage();

    await approverPage.goto(extractLink(invitation.text, "/sign/"));

    const consent = approverPage.getByRole("dialog", {
      name: "Before you approve",
    });

    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
    await expect(consent).toBeHidden();
    await approverPage
      .getByRole("button", { exact: true, name: "Approve" })
      .click();
    await approverPage
      .getByRole("dialog", { name: "Approve this document?" })
      .getByRole("button", { exact: true, name: "Approve" })
      .click();
    await expect(approverPage).toHaveURL(/\/sign\/[^/]+\/done/);
    await expect(
      approverPage.getByText("Your approval has been recorded"),
    ).toBeVisible();
    await context.close();

    await waitForEmail({
      template: "completion_notification",
      to: APPROVER.email,
    });
  });
});
