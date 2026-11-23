import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { extractLink, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

const SIGNER_EMAIL = "paige.pages@example.com";

test("a page with no fields for the signer stays readable", async ({
  browser,
  page,
}, testInfo) => {
  await test.step("the sender puts the only field on the last page", async () => {
    await signInAsAdministrator(page);

    const pdfPath = await writeSamplePdf(testInfo.outputPath("pages.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Field on the last page");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill("Paige Pages");
    await page.getByLabel("Signer 1 email").fill(SIGNER_EMAIL);
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText("Page 2 of 2")).toBeVisible();
    await page.getByRole("button", { exact: true, name: "Signature" }).click();

    const placementTarget = page.getByLabel("Place Signature on page 2");
    const box = await placementTarget.boundingBox();

    await placementTarget.click({
      position: { x: box!.width * 0.3, y: box!.height * 0.75 },
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

  await test.step("page 1 shows the document, and the toolbar says it has no fields", async () => {
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

    // The page opens on the signer's field.
    await expect(signerPage.getByText("Page 2 of 2")).toBeVisible();
    await expect(signerPage.getByText("Current signer view")).toBeVisible();

    await signerPage.getByRole("button", { name: "Previous page" }).click();
    await expect(signerPage.getByText("Page 1 of 2")).toBeVisible();
    await expect(signerPage.getByText("No fields on this page")).toBeVisible();
    await expect(
      signerPage.getByText("No signer fields on this page"),
    ).toHaveCount(0);

    // Nothing sits on top of the page: its middle is the document itself.
    await expect
      .poll(() =>
        signerPage.evaluate(() => {
          const viewport = document.querySelector("[data-field-viewport]");
          const rect = viewport?.getBoundingClientRect();

          return rect
            ? document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              )?.tagName
            : null;
        }),
      )
      .toBe("CANVAS");

    await signerContext.close();
  });
});
