import { readEnv, type EnvSource } from "../utils/env.ts";

// Single sign-on with the organization's own identity provider, over OpenID
// Connect: Okta, Microsoft Entra ID, Google Workspace, or any other provider
// that publishes /.well-known/openid-configuration. It is off unless the
// deployer sets all three of SSO_ISSUER, SSO_CLIENT_ID and SSO_CLIENT_SECRET.
//
// People who sign in this way for the first time get an account under the
// install's sign-up rule (Settings, Organization), the same as a sign-up with
// a password, so the email domain limit holds for both. Someone who already
// has an account with that email address is signed in to it.
//
// PASSWORD_SIGN_IN=off then turns password sign-in off, so the identity
// provider decides who gets in, and its own rules (MFA, offboarding) apply.
// The addresses in PASSWORD_SIGN_IN_ALLOWED_EMAILS keep their password, as a
// way in for an administrator when the provider is down.

/**
 * Whether the identity provider vouches for a profile's email address. Only
 * an explicit yes counts: the address decides which existing account a
 * sign-in is tied to, so a claim that is missing, or anything other than
 * true, leaves it unverified.
 *
 * Microsoft Entra ID never sends email_verified, and an Entra user can set an
 * address in a domain the tenant does not own. Entra's optional xms_edov
 * claim ("email domain owner verified") says the tenant owns the address's
 * domain; add it to the app's ID token under Token configuration to let
 * Entra users sign in to existing accounts.
 */
export function isSsoEmailVerified(profile: Record<string, unknown>): boolean {
  return (
    profile.email_verified === true ||
    profile.email_verified === "true" ||
    profile.xms_edov === true ||
    profile.xms_edov === "true" ||
    profile.xms_edov === 1
  );
}

/** The provider id in Better Auth: its routes end in /oauth2/callback/sso. */
export const SSO_PROVIDER_ID = "sso";

export type SsoConfig = {
  clientId: string;
  clientSecret: string;
  /** The provider's discovery document. */
  discoveryUrl: string;
  issuer: string;
  /** What the button says after "Continue with". */
  name: string;
};

export type PasswordSignInPolicy = {
  /** Lowercased addresses that may still use a password when it is off. */
  allowedEmails: string[];
  enabled: boolean;
};

function normalizeIssuer(value: string): string | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";

  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return null;
  }

  // The issuer may be given with its discovery path, or with a trailing slash.
  return url
    .toString()
    .replace(/\/\.well-known\/openid-configuration\/?$/, "")
    .replace(/\/+$/, "");
}

/**
 * The install's single sign-on settings, or null when it is not set up.
 * A partial or broken setting is reported once and treated as not set up,
 * so a typo cannot stop password sign-in from working.
 */
export function readSsoConfig(env: EnvSource = process.env): SsoConfig | null {
  const rawIssuer = readEnv(env, "SSO_ISSUER");
  const clientId = readEnv(env, "SSO_CLIENT_ID");
  const clientSecret = readEnv(env, "SSO_CLIENT_SECRET");

  if (!rawIssuer && !clientId && !clientSecret) {
    return null;
  }

  if (!rawIssuer || !clientId || !clientSecret) {
    warnOnce(
      "SSO is turned off: set all three of SSO_ISSUER, SSO_CLIENT_ID and SSO_CLIENT_SECRET.",
    );
    return null;
  }

  const issuer = normalizeIssuer(rawIssuer);

  if (!issuer) {
    warnOnce("SSO is turned off: SSO_ISSUER must be an https:// URL.");
    return null;
  }

  return {
    clientId,
    clientSecret,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    issuer,
    name: readEnv(env, "SSO_NAME") ?? "single sign-on",
  };
}

/**
 * Whether password sign-in is on. It can only be turned off while single
 * sign-on is set up, so nobody can be left with no way in at all.
 */
export function readPasswordSignInPolicy(
  env: EnvSource = process.env,
): PasswordSignInPolicy {
  const off =
    readEnv(env, "PASSWORD_SIGN_IN")?.toLowerCase() === "off" &&
    readSsoConfig(env) !== null;

  return {
    allowedEmails: off
      ? (readEnv(env, "PASSWORD_SIGN_IN_ALLOWED_EMAILS") ?? "")
          .split(",")
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean)
      : [],
    enabled: !off,
  };
}

/** Whether this address may sign in, sign up or reset with a password. */
export function mayUsePassword(
  policy: PasswordSignInPolicy,
  email: string,
): boolean {
  return (
    policy.enabled || policy.allowedEmails.includes(email.trim().toLowerCase())
  );
}

const warned = new Set<string>();

function warnOnce(message: string) {
  if (!warned.has(message)) {
    warned.add(message);
    console.warn(`[auth] ${message}`);
  }
}
