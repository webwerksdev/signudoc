import { OrganizationSettings } from "@/components/settings/organization-settings";
import { SettingsShell } from "@/components/settings/settings-shell";
import { UpdatesPanel } from "@/components/settings/updates-panel";
import { isAdminUser } from "@/lib/auth/admin";
import { accountClosureBlock } from "@/lib/account";
import { getAuthSession } from "@/lib/auth/server";
import { toOrganizationSettingsView } from "@/lib/organization-settings";
import {
  getSettings,
  readStoredSettings,
  resolveSettings,
} from "@/lib/settings";
import { usesTwoFactor } from "@/lib/sign-in-security";
import { getUpdateStatus } from "@/lib/software-update";

export default async function SettingsPage() {
  const session = await getAuthSession();
  const isAdmin = session ? await isAdminUser(session.user.id) : false;
  const settings = await getSettings();
  const closureBlockedReason = session
    ? await accountClosureBlock(session.user).catch(() => null)
    : null;

  return (
    <div className="space-y-8">
      <SettingsShell
        closureBlockedReason={closureBlockedReason}
        initialProfile={{
          email: session?.user.email ?? "",
          fullName: session?.user.name ?? "",
        }}
        twoFactor={{
          enabled: session ? usesTwoFactor(session.user) : false,
          required: settings.requireTwoFactor,
        }}
      />
      {isAdmin ? (
        <OrganizationSettings
          // Read fresh, not from the short-lived cache, so the form never
          // shows a value that was just replaced.
          initialSettings={toOrganizationSettingsView(
            resolveSettings(await readStoredSettings()),
          )}
        />
      ) : null}
      {isAdmin ? <UpdatesPanel initialStatus={getUpdateStatus(null)} /> : null}
    </div>
  );
}
