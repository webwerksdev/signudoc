import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { extractLink, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

const TITLE = "SAMPLE - Policy Acknowledgement (training)";
const SIGNER_EMAIL = "harper.header@example.com";

test("on a wide screen a completed envelope's buttons wrap instead of covering its title", async ({
  browser,
  page,
}, testInfo) => {
  let envelopeId = "";

  await test.step("the sender sends a document and the signer finishes it", async () => {
    await signInAsAdministrator(page);

    const pdfPath = await writeSamplePdf(testInfo.outputPath("header.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill(TITLE);
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);
    envelopeId = /\/envelopes\/([^/]+)\/signers$/.exec(page.url())?.[1] ?? "";

    await page.getByLabel("Signer 1 name").fill("Harper Header");
    await page.getByLabel("Signer 1 email").fill(SIGNER_EMAIL);
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
    await confirmation.getByRole("button", { name: "Send now" }).click();
    await expect(page).toHaveURL(new RegExp(`/envelopes/${envelopeId}$`));

    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: SIGNER_EMAIL,
    });
    const signerContext = await browser.newContext();
    const signerPage = await signerContext.newPage();

    await signerPage.goto(extractLink(invitation.text, "/sign/"));

    const consent = signerPage.getByRole("dialog", { name: "Before you sign" });

    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
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
    await signerContext.close();
  });

  for (const width of [1424, 1044]) {
    await test.step(`at ${String(width)} px nothing covers the title`, async () => {
      await page.setViewportSize({ height: 900, width });
      await page.goto(`/envelopes/${envelopeId}`);

      const heading = page.getByRole("heading", { level: 1, name: TITLE });

      await expect(heading).toBeVisible();
      await expect(
        page.getByText("Download certificate").first(),
      ).toBeVisible();

      const layout = await heading.evaluate((title) => {
        const header = title.closest("section")!;
        const titleBox = title.getBoundingClientRect();
        const overlaps = [
          ...header.querySelectorAll<HTMLElement>("a, button"),
        ].filter((control) => {
          if (control.textContent?.startsWith("←")) {
            return false;
          }

          const box = control.getBoundingClientRect();

          return (
            box.width > 0 &&
            box.left < titleBox.right &&
            box.right > titleBox.left &&
            box.top < titleBox.bottom &&
            box.bottom > titleBox.top
          );
        });

        return {
          overflows: title.scrollWidth > title.clientWidth,
          overlaps: overlaps.map((control) => control.textContent),
          width: titleBox.width,
        };
      });

      expect(layout.overlaps).toEqual([]);
      expect(layout.overflows).toBe(false);
      expect(layout.width).toBeGreaterThan(200);
    });
  }
});
