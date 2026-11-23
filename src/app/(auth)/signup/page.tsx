import { SignupShell } from "@/components/auth/signup-shell";
import { redirectIfSignedIn } from "@/lib/auth/server";
import { readPasswordSignInPolicy, readSsoConfig } from "@/lib/auth/sso";
import { buildBranding } from "@/lib/branding";
import { canSendEmail } from "@/lib/services/email";
import { getSettings } from "@/lib/settings";
import { describeSignupPolicy } from "@/lib/signup-policy";

export default async function SignupPage() {
  await redirectIfSignedIn();

  const settings = await getSettings();
  const sso = readSsoConfig();

  return (
    <SignupShell
      emailConnected={canSendEmail()}
      passwordSignIn={readPasswordSignInPolicy().enabled}
      sso={sso ? { name: sso.name } : null}
      signupAvailable={buildBranding(settings).signupAvailable}
      // Says who can sign up before anyone fills the form in. Nothing to
      // say when anyone can.
      signupRule={
        settings.signupMode === "open" ? null : describeSignupPolicy(settings)
      }
    />
  );
}
