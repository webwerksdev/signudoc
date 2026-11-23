import assert from "node:assert/strict";
import { test } from "node:test";

import { PDFDocument } from "pdf-lib";

import { MAX_PDF_PAGES } from "../types/domain.ts";
import { DocumentImportError, importPdfDocument } from "./document-import.ts";

async function pdfWithPages(count: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();

  for (let page = 0; page < count; page += 1) {
    document.addPage([612, 792]);
  }

  return document.save();
}

test("a PDF with more pages than the limit is refused, one at the limit is taken", async () => {
  await assert.rejects(
    importPdfDocument({
      body: await pdfWithPages(MAX_PDF_PAGES + 1),
      contentType: "application/pdf",
      filename: "many.pdf",
    }),
    (error: unknown) =>
      error instanceof DocumentImportError && error.code === "too_many_pages",
  );

  const imported = await importPdfDocument({
    body: await pdfWithPages(MAX_PDF_PAGES),
    contentType: "application/pdf",
    filename: "long.pdf",
  });

  assert.equal(imported.pageCount, MAX_PDF_PAGES);
});
