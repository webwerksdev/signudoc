import { randomUUID } from "node:crypto";

import {
  issueSignedToken,
  presignUrl,
  type IssuedSignedToken,
} from "@vercel/blob";

import {
  buildPendingUploadPrefix,
  isPendingUploadKey,
} from "../services/storage-keys.ts";
import { MAX_UPLOAD_SIZE_BYTES } from "../types/domain.ts";

// Large PDFs for the API. A request to a Vercel Function is capped at
// 4.5 MB, so a bigger file goes straight to Vercel Blob: the API hands out a
// signed URL good for one PUT of one PDF, the caller uploads to it, and then
// names the upload when it creates the envelope. The file is read back and
// checked like any other upload. One that is never used is deleted by Blob
// after a day. This is the same signed-URL mechanism the web app's upload
// page uses.

const UPLOAD_URL_LIFETIME_MS = 10 * 60 * 1000;
const PENDING_UPLOAD_TTL_DAYS = 1;

type IssueToken = (options: {
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  operations: ["put"];
  pathname: string;
  validUntil: number;
}) => Promise<IssuedSignedToken>;

type Presign = typeof presignUrl;

export type ApiUpload = {
  expiresAt: string;
  headers: Record<string, string>;
  maxBytes: number;
  method: "PUT";
  uploadId: string;
  url: string;
};

export function pendingUploadKeyFor(
  userId: string,
  uploadId: string,
): string | null {
  const key = `${buildPendingUploadPrefix(userId)}${uploadId}.pdf`;

  return isPendingUploadKey(key, userId) ? key : null;
}

export async function issueApiUpload(
  userId: string,
  {
    issueToken = issueSignedToken,
    now = Date.now(),
    presign = presignUrl,
  }: { issueToken?: IssueToken; now?: number; presign?: Presign } = {},
): Promise<ApiUpload> {
  const uploadId = randomUUID();
  const pathname = pendingUploadKeyFor(userId, uploadId);

  if (!pathname) {
    throw new Error("Could not build an upload path for this account.");
  }

  const validUntil = now + UPLOAD_URL_LIFETIME_MS;
  const token = await issueToken({
    allowedContentTypes: ["application/pdf"],
    maximumSizeInBytes: MAX_UPLOAD_SIZE_BYTES,
    operations: ["put"],
    pathname,
    validUntil,
  });
  const { presignedUrl } = await presign(token, {
    access: "private",
    addRandomSuffix: false,
    allowedContentTypes: ["application/pdf"],
    allowOverwrite: false,
    maximumSizeInBytes: MAX_UPLOAD_SIZE_BYTES,
    operation: "put",
    pathname,
    ttlDays: PENDING_UPLOAD_TTL_DAYS,
    validUntil,
  });

  return {
    expiresAt: new Date(validUntil).toISOString(),
    headers: { "content-type": "application/pdf" },
    maxBytes: MAX_UPLOAD_SIZE_BYTES,
    method: "PUT",
    uploadId,
    url: presignedUrl,
  };
}
