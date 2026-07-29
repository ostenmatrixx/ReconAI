import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "../../components/app-shell";
import { AuthenticatedSessionBoundary } from "../../components/authenticated-session-boundary";
import { oidcJwtNeedsRefresh } from "../../oidc-session";
import { readServerSessionToken } from "../../server-session";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { readonly children: ReactNode }) {
  const token = await readServerSessionToken();
  if (!token) redirect("/");
  return (
    <AuthenticatedSessionBoundary initiallyReady={!oidcJwtNeedsRefresh(token)}>
      <AppShell>{children}</AppShell>
    </AuthenticatedSessionBoundary>
  );
}
