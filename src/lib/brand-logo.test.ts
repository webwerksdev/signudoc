import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";

import {
  BrandLogoError,
  MAX_LOGO_BYTES,
  checkLogoUpload,
  sniffLogoContentType,
} from "./brand-logo.ts";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46];
const WEBP = [
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
];

// Real 1x1 images, checked to render in Chromium.
const WHOLE_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const WHOLE_JPEG = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQ" +
      "EAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEG" +
      "E1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISU" +
      "pTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKz" +
      "tLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAw" +
      "EBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEE" +
      "BSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5Ok" +
      "NERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOk" +
      "paanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9" +
      "sAQwAbGxsbGxsvGxsvQi8vL0JZQkJCQllwWVlZWVlwiHBwcHBwcIiIiIiIiIiIo6Ojo6Oj" +
      "vr6+vr7V1dXV1dXV1dXV/9sAQwEhIyM2MjZdMjJd35d8l9/f39/f39/f39/f39/f39/f39" +
      "/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f/90ABAAB/9oADAMBAAIRAxEAPwCS" +
      "iiivQJP/2Q==",
    "base64",
  ),
);
const WHOLE_WEBP = Uint8Array.from(
  Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"),
);
const WHOLE_IMAGES = [
  ["image/png", WHOLE_PNG],
  ["image/jpeg", WHOLE_JPEG],
  ["image/webp", WHOLE_WEBP],
] as const;

test("the kind of image is read from the bytes", () => {
  assert.equal(sniffLogoContentType(Uint8Array.from(PNG)), "image/png");
  assert.equal(sniffLogoContentType(Uint8Array.from(JPEG)), "image/jpeg");
  assert.equal(sniffLogoContentType(Uint8Array.from(WEBP)), "image/webp");
});

test("anything else is not a logo, SVG and HTML included", () => {
  const encoder = new TextEncoder();

  for (const bytes of [
    encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    encoder.encode("<!doctype html><script>alert(1)</script>"),
    encoder.encode("GIF89a"),
    encoder.encode("%PDF-1.7"),
    // A RIFF file that is not WebP (a WAV sound).
    Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ]),
    Uint8Array.from([0x89, 0x50]),
  ]) {
    assert.equal(sniffLogoContentType(bytes), null);
    assert.throws(() => checkLogoUpload(bytes), BrandLogoError);
  }
});

test("an empty or oversized upload is refused with a reason", () => {
  assert.throws(
    () => checkLogoUpload(new Uint8Array()),
    (error: unknown) =>
      error instanceof BrandLogoError && error.statusCode === 400,
  );

  const tooLarge = new Uint8Array(MAX_LOGO_BYTES + 1);

  tooLarge.set(PNG);
  assert.throws(
    () => checkLogoUpload(tooLarge),
    (error: unknown) =>
      error instanceof BrandLogoError && error.statusCode === 413,
  );

  const largest = new Uint8Array(MAX_LOGO_BYTES);

  largest.set(WHOLE_PNG);
  assert.equal(checkLogoUpload(largest), "image/png");
});

test("a whole image is taken as what it is", () => {
  for (const [contentType, bytes] of WHOLE_IMAGES) {
    assert.equal(checkLogoUpload(bytes), contentType);
  }
});

test("an image cut off anywhere is refused, though it starts right", () => {
  for (const [contentType, bytes] of WHOLE_IMAGES) {
    for (let length = 1; length < bytes.length; length += 1) {
      const cut = bytes.subarray(0, length);

      assert.throws(
        () => checkLogoUpload(cut),
        (error: unknown) =>
          error instanceof BrandLogoError && error.statusCode === 400,
        `${contentType} cut to ${length} bytes`,
      );
    }
  }
});

test("a PNG with a damaged byte is refused", () => {
  // Flip a byte inside IDAT so only the CRC can catch it.
  const damaged = Uint8Array.from(WHOLE_PNG);

  damaged[45] ^= 0xff;
  assert.equal(sniffLogoContentType(damaged), "image/png");
  assert.throws(() => checkLogoUpload(damaged), BrandLogoError);
});

function pngChunk(type: string, data: Uint8Array = new Uint8Array()) {
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const chunk = Buffer.alloc(typeAndData.length + 8);

  chunk.writeUInt32BE(data.length, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typeAndData), chunk.length - 4);

  return chunk;
}

// Builds a PNG from raw scanlines (filter byte first), so tests can break one part.
function buildPng(options: {
  bitDepth?: number;
  colorType?: number;
  height: number;
  idat?: Uint8Array;
  interlaced?: boolean;
  palette?: boolean;
  raw?: Uint8Array;
  width: number;
}) {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(options.width, 0);
  header.writeUInt32BE(options.height, 4);
  header[8] = options.bitDepth ?? 8;
  header[9] = options.colorType ?? 6;
  header[12] = options.interlaced ? 1 : 0;

  return Uint8Array.from(
    Buffer.concat([
      WHOLE_PNG.subarray(0, 8),
      pngChunk("IHDR", header),
      ...(options.palette ? [pngChunk("PLTE", Buffer.from([0, 0, 0]))] : []),
      pngChunk(
        "IDAT",
        options.idat ?? deflateSync(options.raw ?? new Uint8Array()),
      ),
      pngChunk("IEND"),
    ]),
  );
}

test("a WebP chunk with a huge length is refused, not looped on", () => {
  // RIFF size 12, then a JUNK chunk whose length is 0xfffffff8.
  const bytes = Buffer.alloc(20);

  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(12, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("JUNK", 12, "latin1");
  bytes.writeUInt32LE(0xfffffff8, 16);

  assert.throws(() => checkLogoUpload(bytes), BrandLogoError);
});

test("a WebP with only its image header is refused", () => {
  // The fixture's VP8L chunk cut to its 5 header bytes, plus padding.
  const bytes = Buffer.concat([WHOLE_WEBP.subarray(0, 25), Buffer.alloc(1)]);

  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.writeUInt32LE(5, 16);
  assert.throws(() => checkLogoUpload(bytes), BrandLogoError);
});

test("a PNG is refused unless its pixel data is all there", () => {
  // 2x2 RGBA: two rows of a filter byte and 8 pixel bytes.
  const raw = new Uint8Array(18);

  assert.equal(
    checkLogoUpload(buildPng({ height: 2, raw, width: 2 })),
    "image/png",
  );

  for (const broken of [
    buildPng({ height: 2, idat: new Uint8Array(), width: 2 }),
    buildPng({ height: 2, raw: raw.subarray(0, 9), width: 2 }),
    buildPng({ height: 2, raw: Uint8Array.from([...raw, 0]), width: 2 }),
    buildPng({ height: 2, idat: deflateSync(raw).subarray(0, 6), width: 2 }),
    buildPng({
      height: 2,
      raw: Uint8Array.from([9, ...raw.subarray(1)]),
      width: 2,
    }),
  ]) {
    assert.throws(() => checkLogoUpload(broken), BrandLogoError);
  }
});

test("interlaced and palette PNGs are measured right", () => {
  // 3x3 RGBA in Adam7: passes 2 and 3 are empty, the rest hold rows of
  // 1, 1, 2, 1, 1 and 3 pixels.
  const interlaced = new Uint8Array(5 + 5 + 9 + 5 + 5 + 13);

  assert.equal(
    checkLogoUpload(
      buildPng({ height: 3, interlaced: true, raw: interlaced, width: 3 }),
    ),
    "image/png",
  );

  // 10x1 at 4 bits per pixel: 5 bytes and a filter byte.
  const palette = {
    bitDepth: 4,
    colorType: 3,
    height: 1,
    raw: new Uint8Array(6),
    width: 10,
  };

  assert.equal(
    checkLogoUpload(buildPng({ ...palette, palette: true })),
    "image/png",
  );
  assert.throws(() => checkLogoUpload(buildPng(palette)), BrandLogoError);
});

test("a PNG that would inflate past the pixel limit is refused", () => {
  assert.throws(
    () =>
      checkLogoUpload(
        buildPng({
          height: 8000,
          idat: deflateSync(new Uint8Array(1)),
          width: 8000,
        }),
      ),
    (error: unknown) =>
      error instanceof BrandLogoError && /too many pixels/.test(error.message),
  );
});

test("a PNG palette must be one, early, whole and in range", () => {
  // 10x1 at 4 bits per pixel: 5 bytes and a filter byte.
  const raw = deflateSync(new Uint8Array(6));
  const header = Buffer.alloc(13);

  header.writeUInt32BE(10, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 4;
  header[9] = 3;

  const png = (...chunks: Buffer[]) =>
    Uint8Array.from(
      Buffer.concat([
        WHOLE_PNG.subarray(0, 8),
        pngChunk("IHDR", header),
        ...chunks,
        pngChunk("IEND"),
      ]),
    );
  const palette = (entries: number) =>
    pngChunk("PLTE", Buffer.alloc(entries * 3));

  assert.equal(
    checkLogoUpload(png(palette(16), pngChunk("IDAT", raw))),
    "image/png",
  );

  for (const broken of [
    png(pngChunk("PLTE"), pngChunk("IDAT", raw)),
    png(pngChunk("PLTE", Buffer.alloc(4)), pngChunk("IDAT", raw)),
    // Four bits can index 16 colors, not 17.
    png(palette(17), pngChunk("IDAT", raw)),
    png(palette(2), palette(2), pngChunk("IDAT", raw)),
    png(pngChunk("IDAT", raw), palette(2)),
  ]) {
    assert.throws(() => checkLogoUpload(broken), BrandLogoError);
  }

  // A grey image has no palette at all.
  header[9] = 0;
  assert.throws(
    () => checkLogoUpload(png(palette(2), pngChunk("IDAT", raw))),
    BrandLogoError,
  );
});

/** The fixture JPEG's segments, as [marker, start, end] up to the scan. */
function jpegSegments(bytes: Uint8Array) {
  const segments: Array<[number, number, number]> = [];
  let offset = 2;

  for (;;) {
    const marker = bytes[offset + 1];
    const end = offset + 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);

    segments.push([marker, offset, end]);

    if (marker === 0xda) {
      return segments;
    }

    offset = end;
  }
}

test("a JPEG with no quantization table or no scan data is refused", () => {
  const segments = jpegSegments(WHOLE_JPEG);
  const withoutTables = Buffer.concat([
    WHOLE_JPEG.subarray(0, 2),
    ...segments
      .filter(([marker]) => marker !== 0xdb)
      .map(([, start, end]) => WHOLE_JPEG.subarray(start, end)),
    WHOLE_JPEG.subarray(segments.at(-1)![2]),
  ]);
  const scanEnd = segments.at(-1)![2];
  const emptyScan = Buffer.concat([
    WHOLE_JPEG.subarray(0, scanEnd),
    Buffer.from([0xff, 0xd9]),
  ]);

  assert.ok(segments.some(([marker]) => marker === 0xdb));
  assert.equal(sniffLogoContentType(withoutTables), "image/jpeg");
  assert.throws(() => checkLogoUpload(withoutTables), BrandLogoError);
  assert.throws(() => checkLogoUpload(emptyScan), BrandLogoError);
});

/** A RIFF WebP holding these chunks. */
function buildWebp(...chunks: Buffer[]) {
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  const head = Buffer.alloc(8);

  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);

  return Uint8Array.from(Buffer.concat([head, body]));
}

function webpChunk(type: string, data: Uint8Array) {
  const head = Buffer.alloc(8);

  head.write(type, 0, "latin1");
  head.writeUInt32LE(data.length, 4);

  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}

test("a WebP animation frame must hold an image", () => {
  // The fixture's VP8L chunk, padding included.
  const image = Buffer.from(WHOLE_WEBP.subarray(12));
  const frameHeader = Buffer.alloc(16);

  assert.equal(
    checkLogoUpload(
      buildWebp(webpChunk("ANMF", Buffer.concat([frameHeader, image]))),
    ),
    "image/webp",
  );
  assert.throws(
    () => checkLogoUpload(buildWebp(webpChunk("ANMF", new Uint8Array()))),
    BrandLogoError,
  );
  assert.throws(
    () => checkLogoUpload(buildWebp(webpChunk("ANMF", frameHeader))),
    BrandLogoError,
  );
});

test("a WebP whose last chunk's padding runs past the file is refused", () => {
  // An odd-sized chunk with its padding byte left off.
  const bytes = buildWebp(Buffer.from(WHOLE_WEBP.subarray(12, -1)));

  assert.throws(() => checkLogoUpload(bytes), BrandLogoError);
});

test("a lossy WebP whose first partition runs past its data is refused", () => {
  // A key frame tag declaring a 64-byte first partition, a 1x1 frame, and
  // only 2 bytes of data after the 10-byte header.
  const frame = Buffer.from([
    0x10, 0x08, 0x00, 0x9d, 0x01, 0x2a, 1, 0, 1, 0, 0, 0,
  ]);

  assert.throws(
    () => checkLogoUpload(buildWebp(webpChunk("VP8 ", frame))),
    BrandLogoError,
  );
});

test("a PNG whose end marker carries data is refused", () => {
  const png = buildPng({ height: 2, raw: new Uint8Array(18), width: 2 });
  // Swap the empty IEND for one holding a byte.
  const bytes = Buffer.concat([
    png.subarray(0, png.length - 12),
    pngChunk("IEND", Buffer.from([0])),
  ]);

  assert.throws(() => checkLogoUpload(bytes), BrandLogoError);
});
