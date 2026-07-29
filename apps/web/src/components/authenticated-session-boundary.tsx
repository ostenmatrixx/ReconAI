"use client";

import { KeyRound, LoaderCircle } from "lucide-react";
import { SessionProvider, signIn, useSession } from "next-auth/react";
import type { ReactNode } from "react";

export function AuthenticatedSessionBoundary({
  children,
  initiallyReady,
}: {
  readonly children: ReactNode;
  readonly initiallyReady: boolean;
}) {
  return (
    <SessionProvider refetchInterval={60} refetchOnWindowFocus refetchWhenOffline={false}>
      <SessionReadiness initiallyReady={initiallyReady}>{children}</SessionReadiness>
    </SessionProvider>
  );
}

function SessionReadiness({
  children,
  initiallyReady,
}: {
  readonly children: ReactNode;
  readonly initiallyReady: boolean;
}) {
  const { data: session, status } = useSession();

  if (status === "authenticated" && !session.reauthenticationRequired) return children;
  if (status === "loading" && initiallyReady) return children;

  if (status === "loading") {
    return (
      <main className="session-gate">
        <LoaderCircle aria-hidden="true" className="spin" size={22} />
        <div aria-live="polite">
          <strong>Verifying your secure session</strong>
          <p>Provider credentials remain inside the encrypted, HTTP-only session.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="session-gate" role="alert">
      <KeyRound aria-hidden="true" size={22} />
      <div>
        <strong>Your identity-provider session needs to be renewed</strong>
        <p>No expired provider credential was sent to the ReconAI API.</p>
        <button
          className="button button--primary"
          onClick={() => {
            void signIn("keycloak", { callbackUrl: window.location.href });
          }}
          type="button"
        >
          Sign in again
        </button>
      </div>
    </main>
  );
}
