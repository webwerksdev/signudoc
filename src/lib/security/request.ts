import { isIP } from "node:net";

type IpEnv = Record<string, string | undefined>;

function firstAddress(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

/** An address on a private network, or the machine itself. */
function isInternalAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);

    return (
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (version === 6) {
    const lower = address.toLowerCase();

    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80:") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.")
    );
  }

  return false;
}

/**
 * The visitor's address from an X-Forwarded-For list. Each proxy adds the
 * address it was reached from at the end, so anything at the start may be
 * the visitor's own invention. Read from the end, passing over the
 * install's own proxies on a private network: the first address left is
 * the one the outermost proxy saw.
 */
function forwardedForAddress(value: string | null): string | null {
  const addresses = (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    const address = addresses[index]!;

    if (!isInternalAddress(address)) {
      return address;
    }
  }

  return addresses[0] ?? null;
}

/**
 * The headers that carry the visitor's address, most trustworthy first.
 *
 * On Vercel, x-vercel-forwarded-for and x-real-ip are written by Vercel
 * itself and cannot be set by the visitor, so they come first.
 * https://vercel.com/docs/headers/request-headers
 *
 * Anywhere else those two names mean nothing special and anyone could send
 * them, so the usual proxy headers are used instead. There the app has to
 * sit behind a reverse proxy that sets them: X-Forwarded-For is read from
 * its end (see forwardedForAddress), so what a visitor puts at its start
 * does not count.
 */
export function getClientIpHeaderNames(env: IpEnv = process.env): string[] {
  return env.VERCEL === "1"
    ? ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]
    : ["x-forwarded-for", "cf-connecting-ip", "x-real-ip"];
}

export function getClientIpAddress(
  headers: Headers,
  env: IpEnv = process.env,
): string | null {
  const offVercel = env.VERCEL !== "1";

  for (const name of getClientIpHeaderNames(env)) {
    const address =
      offVercel && name === "x-forwarded-for"
        ? forwardedForAddress(headers.get(name))
        : firstAddress(headers.get(name));

    if (address) {
      return address;
    }
  }

  return null;
}

export function getRequestUserAgent(headers: Headers): string | null {
  // A header sent with no value reads as "", which the audit schema
  // rejects; it counts as no user agent at all.
  return headers.get("user-agent")?.trim() || null;
}

/** Who made a request, as the audit trail records it. */
export type RequestClient = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export function getRequestClient(
  headers: Headers | null | undefined,
  env: IpEnv = process.env,
): { ipAddress: string | null; userAgent: string | null } {
  if (!headers) {
    return { ipAddress: null, userAgent: null };
  }

  return {
    ipAddress: getClientIpAddress(headers, env),
    userAgent: getRequestUserAgent(headers),
  };
}

export function getRequestPathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/";
  }
}
