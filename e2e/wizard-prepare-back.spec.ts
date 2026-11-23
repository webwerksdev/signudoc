import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

test("Back from Place fields keeps a field placed just before it", async ({
  page,
}, testInfo) => {
  // The page's clock runs as usual until it is paused below.
  await page.clock.install();
  await signInAsAdministrator(page);

  const pdfPath = await writeSamplePdf(testInfo.outputPath("back.pdf"));

  await page.goto("/envelopes/new");
  await page.getByLabel("Envelope title").fill("Placed then back");
  await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
  await page.getByRole("button", { name: "Next ->" }).click();
  await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

  const envelopeId =
    /\/envelopes\/([^/]+)\/signers$/.exec(page.url())?.[1] ?? "";

  await page.getByLabel("Signer 1 name").fill("Bailey Back");
  await page.getByLabel("Signer 1 email").fill("bailey.back@example.com");
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page).toHaveURL(/\/prepare$/);
  await expect(
    page.getByRole("img", { name: "Rendered PDF page 1" }),
  ).toBeVisible();

  const back = page.getByRole("link", { exact: true, name: "Back" });
  const backBox = await back.boundingBox();

  await page.getByRole("button", { exact: true, name: "Signature" }).click();

  const placementTarget = page.getByLabel("Place Signature on page 1");
  const box = await placementTarget.boundingBox();

  expect(box).not.toBeNull();
  expect(backBox).not.toBeNull();
  // Stop the page's timers, so the autosave cannot run before Back is
  // clicked: only Back's own save can keep the field.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await placementTarget.click({
    position: { x: box!.width * 0.3, y: box!.height * 0.6 },
  });
  await expect(
    page.getByRole("button", { name: "Bailey Back · Sign" }),
  ).toBeVisible();
  await page.mouse.click(
    backBox!.x + backBox!.width / 2,
    backBox!.y + backBox!.height / 2,
  );
  await page.clock.resume();
  await expect(page).toHaveURL(new RegExp(`/envelopes/${envelopeId}/signers$`));

  await page.goto(`/envelopes/${envelopeId}/prepare`);
  await expect(
    page.getByRole("button", { name: "Bailey Back · Sign" }),
  ).toBeVisible();
});
