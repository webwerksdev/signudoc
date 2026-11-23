import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

/** Writes a small two-page PDF and returns its path. */
export async function writeSamplePdf(filePath: string): Promise<string> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);

  for (const pageNumber of [1, 2]) {
    const page = document.addPage([612, 792]);

    page.drawText(`Sample agreement, page ${String(pageNumber)}`, {
      font,
      size: 18,
      x: 72,
      y: 700,
    });
    page.drawText("Signature: ______________________", {
      font,
      size: 12,
      x: 72,
      y: 200,
    });
  }

  await writeFile(filePath, await document.save());

  return filePath;
}

/**
 * Writes a one-page PDF padded to about `sizeBytes` with an attached file of
 * random bytes, which cannot be compressed, and returns its path.
 */
export async function writeLargePdf(
  filePath: string,
  sizeBytes: number,
): Promise<string> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);

  page.drawText("Large sample agreement", { font, size: 18, x: 72, y: 700 });

  const padding = document.context.register(
    document.context.stream(randomBytes(sizeBytes), { Type: "EmbeddedFile" }),
  );
  const name = PDFString.of("padding.bin");

  document.catalog.set(
    PDFName.of("Names"),
    document.context.obj({
      EmbeddedFiles: {
        Names: [
          name,
          document.context.obj({
            EF: { F: padding },
            F: name,
            Type: "Filespec",
          }),
        ],
      },
    }),
  );

  await writeFile(filePath, await document.save());

  return filePath;
}
