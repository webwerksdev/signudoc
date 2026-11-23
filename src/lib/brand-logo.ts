import { createHash } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";

import { MAX_LOGO_BYTES, type LogoContentType } from "./branding.ts";
import { getDb, queryOne, type DbExecutor } from "./db/connection.ts";
import { invalidateSettingsCache, isMissingSchemaError } from "./settings.ts";

// The install's logo: one small image, kept in the settings row.
//
// It is shown to everyone, signers included, so what is stored is decided
// by looking at the bytes, never by what the upload claimed to be. SVG is
// not accepted: it can carry scripts, and email programs do not show it.

export { MAX_LOGO_BYTES, type LogoContentType } from "./branding.ts";

export type BrandLogo = {
  bytes: Uint8Array;
  contentType: LogoContentType;
  /** The start of the image's SHA-256: the same image, the same version. */
  version: string;
};

export class BrandLogoError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "BrandLogoError";
    this.statusCode = statusCode;
  }
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return (
    bytes.length >= offset + signature.length &&
    signature.every((value, index) => bytes[offset + index] === value)
  );
}

/** What kind of image these bytes are, or null when it is not one we take. */
export function sniffLogoContentType(
  bytes: Uint8Array,
): LogoContentType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  // "RIFF" <size> "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }

  return null;
}

function readUint32BE(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

function readUint32LE(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset + 3] * 0x1000000 +
    ((bytes[offset + 2] << 16) | (bytes[offset + 1] << 8) | bytes[offset])
  );
}

function readUint16BE(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function chunkType(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

// Caps the inflated pixel data so a tiny file can't expand into gigabytes.
const MAX_PNG_PIXEL_BYTES = 64 * 1024 * 1024;

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_BIT_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

// Adam7 passes: x start, y start, x step, y step.
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

type PngHeader = {
  bitDepth: number;
  colorType: number;
  height: number;
  interlaced: boolean;
  width: number;
};

function readPngHeader(bytes: Uint8Array, offset: number): PngHeader | null {
  const header = {
    bitDepth: bytes[offset + 8],
    colorType: bytes[offset + 9],
    height: readUint32BE(bytes, offset + 4),
    interlaced: bytes[offset + 12] === 1,
    width: readUint32BE(bytes, offset),
  };

  const valid =
    header.width > 0 &&
    header.height > 0 &&
    PNG_BIT_DEPTHS[header.colorType]?.includes(header.bitDepth) === true &&
    bytes[offset + 10] === 0 &&
    bytes[offset + 11] === 0 &&
    bytes[offset + 12] <= 1;

  return valid ? header : null;
}

/** Rows and bytes per row (filter byte included) of each pass. */
function pngScanlines(header: PngHeader): Array<[number, number]> {
  const bitsPerPixel = PNG_CHANNELS[header.colorType] * header.bitDepth;
  const passes = header.interlaced ? ADAM7 : [[0, 0, 1, 1]];

  return passes
    .map(([xStart, yStart, xStep, yStep]): [number, number] => {
      const columns = Math.ceil((header.width - xStart) / xStep);
      const rows = Math.ceil((header.height - yStart) / yStep);

      return columns > 0 && rows > 0
        ? [rows, Math.ceil((columns * bitsPerPixel) / 8) + 1]
        : [0, 0];
    })
    .filter(([rows]) => rows > 0);
}

function hasWholePngPixels(header: PngHeader, data: Uint8Array[]): boolean {
  const scanlines = pngScanlines(header);
  const expected = scanlines.reduce(
    (sum, [rows, size]) => sum + rows * size,
    0,
  );

  if (expected > MAX_PNG_PIXEL_BYTES) {
    throw new BrandLogoError(
      "This image has too many pixels for a logo. Choose a smaller one.",
    );
  }

  let pixels: Buffer;

  try {
    pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
  } catch {
    return false;
  }

  if (pixels.length !== expected) {
    return false;
  }

  // Every row starts with a filter type from 0 to 4.
  let offset = 0;

  for (const [rows, size] of scanlines) {
    for (let row = 0; row < rows; row += 1, offset += size) {
      if (pixels[offset] > 4) {
        return false;
      }
    }
  }

  return true;
}

function isCompletePng(bytes: Uint8Array): boolean {
  let offset = 8;
  let header: PngHeader | null = null;
  let seenPalette = false;
  const data: Uint8Array[] = [];

  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = chunkType(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > bytes.length) {
      return false;
    }

    const expectedCrc = readUint32BE(bytes, dataEnd);

    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== expectedCrc) {
      return false;
    }

    if (!header) {
      if (type !== "IHDR" || length !== 13) {
        return false;
      }

      header = readPngHeader(bytes, dataStart);

      if (!header) {
        return false;
      }
    } else if (type === "PLTE") {
      // One palette, before the pixel data, of whole RGB entries: no more
      // than 256, nor more than the bit depth can index. Grey images have
      // none.
      const entries = length / 3;

      if (
        seenPalette ||
        data.length > 0 ||
        header.colorType === 0 ||
        header.colorType === 4 ||
        length === 0 ||
        length % 3 !== 0 ||
        entries > 256 ||
        (header.colorType === 3 && entries > 2 ** header.bitDepth)
      ) {
        return false;
      }

      seenPalette = true;
    } else if (type === "IDAT") {
      data.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      // The end marker carries nothing.
      if (
        length !== 0 ||
        data.length === 0 ||
        (header.colorType === 3 && !seenPalette)
      ) {
        return false;
      }

      return hasWholePngPixels(header, data);
    }

    offset = dataEnd + 4;
  }

  return false;
}

function isCompleteJpeg(bytes: Uint8Array): boolean {
  let offset = 2;
  let seenFrame = false;
  let seenQuantization = false;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return false;
    }

    const marker = bytes[offset + 1];

    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    // These markers have no length field, so just step over them.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    if (marker === 0xd9) {
      return false;
    }

    const length = readUint16BE(bytes, offset + 2);
    const segmentEnd = offset + 2 + length;

    if (length < 2 || segmentEnd > bytes.length) {
      return false;
    }

    // Frame headers (C0-CF) hold the size; C4, C8 and CC aren't frames.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (length < 8) {
        return false;
      }

      const height = readUint16BE(bytes, offset + 5);
      const width = readUint16BE(bytes, offset + 7);

      if (width === 0 || height === 0) {
        return false;
      }

      seenFrame = true;
    }

    // Every JPEG needs a quantization table to decode.
    if (marker === 0xdb) {
      seenQuantization = true;
    }

    // Image data starts here, so all that's left is to find the end marker.
    if (marker === 0xda) {
      if (!seenFrame || !seenQuantization) {
        return false;
      }

      // At least one byte of scan data before the end marker.
      for (let index = bytes.length - 2; index > segmentEnd; index -= 1) {
        if (bytes[index] === 0xff && bytes[index + 1] === 0xd9) {
          return true;
        }
      }

      return false;
    }

    offset = segmentEnd;
  }

  return false;
}

function isCompleteWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) {
    return false;
  }

  const riffEnd = 8 + readUint32LE(bytes, 4);

  if (riffEnd > bytes.length) {
    return false;
  }

  return hasWebpImage(bytes, 12, riffEnd, true);
}

/**
 * Walks the chunks from start to end, which must fill it exactly, and says
 * whether one holds an image. An animation frame (ANMF) is a 16-byte frame
 * header and chunks of its own, which must hold an image too.
 */
function hasWebpImage(
  bytes: Uint8Array,
  start: number,
  end: number,
  allowFrames: boolean,
): boolean {
  let offset = start;
  let seenImage = false;

  while (offset + 8 <= end) {
    const type = chunkType(bytes, offset);
    const length = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    // Odd-sized chunks get one byte of padding.
    const paddedEnd = dataEnd + (length % 2);

    if (paddedEnd > end || dataEnd <= offset) {
      return false;
    }

    if (type === "VP8 ") {
      // A key frame header with its size, and a first partition that fits
      // in the data after it. The frame tag's top 19 bits give that size.
      const firstPartitionSize =
        length > 10
          ? (bytes[dataStart] |
              (bytes[dataStart + 1] << 8) |
              (bytes[dataStart + 2] << 16)) >>>
            5
          : 0;

      if (
        length <= 10 ||
        firstPartitionSize === 0 ||
        firstPartitionSize > length - 10 ||
        !startsWith(bytes, [0x9d, 0x01, 0x2a], dataStart + 3) ||
        (readUint16LE(bytes, dataStart + 6) & 0x3fff) === 0 ||
        (readUint16LE(bytes, dataStart + 8) & 0x3fff) === 0
      ) {
        return false;
      }

      seenImage = true;
    } else if (type === "VP8L") {
      // Signature, size and a zero version, and some data after them.
      if (
        length <= 5 ||
        bytes[dataStart] !== 0x2f ||
        bytes[dataStart + 4] >> 5 !== 0
      ) {
        return false;
      }

      seenImage = true;
    } else if (type === "ANMF") {
      if (
        !allowFrames ||
        length <= 16 ||
        !hasWebpImage(bytes, dataStart + 16, dataEnd, false)
      ) {
        return false;
      }

      seenImage = true;
    }

    offset = paddedEnd;
  }

  return seenImage && offset === end;
}

const COMPLETE_CHECKS: Record<LogoContentType, (bytes: Uint8Array) => boolean> =
  {
    "image/jpeg": isCompleteJpeg,
    "image/png": isCompletePng,
    "image/webp": isCompleteWebp,
  };

/** Checks an upload and says what it is. Throws when it cannot be a logo. */
export function checkLogoUpload(bytes: Uint8Array): LogoContentType {
  if (bytes.length === 0) {
    throw new BrandLogoError("Choose an image to upload.");
  }

  if (bytes.length > MAX_LOGO_BYTES) {
    throw new BrandLogoError("The logo must be 512 KB or smaller.", 413);
  }

  const contentType = sniffLogoContentType(bytes);

  if (!contentType) {
    throw new BrandLogoError("The logo must be a PNG, JPEG or WebP image.");
  }

  // A matching signature doesn't mean the rest of the file is there.
  if (!COMPLETE_CHECKS[contentType](bytes)) {
    throw new BrandLogoError(
      "This image is damaged or incomplete. Choose another file.",
    );
  }

  return contentType;
}

type LogoRow = {
  logo_content_type: LogoContentType | null;
  logo_data: Buffer | null;
  logo_hash: string | null;
};

/**
 * Stores the logo, replacing any there was, and returns its version.
 *
 * The version is the start of the image's hash. The address the logo is
 * served at carries it and is cached for good, so a different image always
 * gets a different address and the same image keeps the one it had.
 */
export async function saveBrandLogo(
  bytes: Uint8Array,
  database: DbExecutor = getDb(),
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const contentType = checkLogoUpload(bytes);
  const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);

  // An install that was never set up has no settings row. Sign-up stays as
  // it was without one: open.
  await database.query(
    `
      insert into public.app_settings (
        id,
        signup_mode,
        logo_content_type,
        logo_data,
        logo_hash,
        created_at,
        updated_at
      )
      values (true, 'open', $1, $2, $3, $4, $4)
      on conflict (id) do update set
        logo_content_type = excluded.logo_content_type,
        logo_data = excluded.logo_data,
        logo_hash = excluded.logo_hash,
        updated_at = excluded.updated_at
    `,
    [contentType, Buffer.from(bytes), version, now],
  );

  invalidateSettingsCache();

  return version;
}

/** Removes the logo. Nothing happens when there is none. */
export async function removeBrandLogo(
  database: DbExecutor = getDb(),
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  await database.query(
    `
      update public.app_settings
      set
        logo_content_type = null,
        logo_data = null,
        logo_hash = null,
        updated_at = $1
      where id and logo_data is not null
    `,
    [now],
  );

  invalidateSettingsCache();
}

/** The stored logo, or null when there is none (or no column for it yet). */
export async function readBrandLogo(
  database: DbExecutor = getDb(),
): Promise<BrandLogo | null> {
  let row: LogoRow | null;

  try {
    row = await queryOne<LogoRow>(
      database,
      `
        select logo_content_type, logo_data, logo_hash
        from public.app_settings
        where id
      `,
    );
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return null;
    }

    throw error;
  }

  if (!row?.logo_data || !row.logo_content_type || !row.logo_hash) {
    return null;
  }

  return {
    bytes: new Uint8Array(row.logo_data),
    contentType: row.logo_content_type,
    version: row.logo_hash,
  };
}
