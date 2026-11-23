import { notFound } from "next/navigation";

import { BulkSendShell } from "@/components/templates/bulk-send-shell";
import { getAuthSession } from "@/lib/auth/server";
import { exampleCsvForRoles, MAX_BULK_SEND_ROWS } from "@/lib/bulk-send-csv";
import { getDb } from "@/lib/db/connection";
import { getSettings } from "@/lib/settings";
import {
  describeUnsendableTemplate,
  getTemplateForBulkSend,
  TemplateError,
} from "@/lib/templates";

type BulkSendPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function BulkSendPage({ params }: BulkSendPageProps) {
  const { id } = await params;
  let template: Awaited<ReturnType<typeof getTemplateForBulkSend>> = null;
  let errorMessage: string | undefined;
  let failed = false;
  let part11Mode = false;

  try {
    const session = await getAuthSession();
    const loaded = session
      ? await getTemplateForBulkSend(session.user.id, id, getDb())
      : null;
    const unsendable = loaded
      ? describeUnsendableTemplate(loaded.roles, loaded.fields)
      : null;

    if (unsendable) {
      failed = true;
      errorMessage = unsendable;
    } else {
      template = loaded;
    }
  } catch (error) {
    failed = true;
    errorMessage = error instanceof TemplateError ? error.message : undefined;
  }

  try {
    part11Mode = (await getSettings()).part11Mode;
  } catch {
    part11Mode = false;
  }

  if (!failed && !template) {
    notFound();
  }

  const shellTemplate = template
    ? {
        fieldCountLabel: template.fieldCountLabel,
        id: template.id,
        name: template.name,
        pageCountLabel: template.pageCountLabel,
        roles: template.roles,
      }
    : undefined;

  return (
    <BulkSendShell
      errorMessage={errorMessage}
      exampleCsv={
        shellTemplate
          ? exampleCsvForRoles(shellTemplate.roles.map((role) => role.name))
          : ""
      }
      key={id}
      maxRows={MAX_BULK_SEND_ROWS}
      part11Mode={part11Mode}
      template={shellTemplate}
    />
  );
}
