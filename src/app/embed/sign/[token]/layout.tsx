import type { Metadata } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";

import { BrandingProvider } from "@/components/layout/branding-provider";
import { getInstallMetadata } from "@/lib/install";
import { getBranding } from "@/lib/settings";

export async function generateMetadata(): Promise<Metadata> {
  await connection();

  return getInstallMetadata();
}

// Embedded signing pages carry the name of the organization that sent the
// document, as the emailed ones do.
export default async function EmbeddedSigningLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  await connection();

  return (
    <BrandingProvider branding={await getBranding()}>
      {children}
    </BrandingProvider>
  );
}
