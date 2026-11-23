import { isIP } from "node:net";

// Addresses an outgoing request from the app must not reach on its own
// accord: loopback, private networks, link-local (cloud metadata services
// live there), carrier-grade NAT, benchmarking, multicast and reserved
// ranges. Used for fetches whose address comes from outside, such as
// revocation lookups named in a certificate and webhook endpoints.

/** True when `host` (a name or an IP address, brackets allowed) is private. */
export function isPrivateAddress(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").toLowerCase();

  if (address === "localhost" || address.endsWith(".localhost")) {
    return true;
  }

  const version = isIP(address);

  if (version === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      // Multicast, reserved and broadcast.
      a >= 224
    );
  }

  if (version === 6) {
    // An IPv4 address mapped into IPv6, which URL writes in hex.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
    const mapped = hex
      ? [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)]
          .flatMap((word) => [word >> 8, word & 0xff])
          .join(".")
      : /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];

    return (
      address === "::" ||
      address === "::1" ||
      /^f[cd]/.test(address) ||
      /^fe[89ab]/.test(address) ||
      /^ff/.test(address) ||
      (mapped ? isPrivateAddress(mapped) : false)
    );
  }

  return false;
}
