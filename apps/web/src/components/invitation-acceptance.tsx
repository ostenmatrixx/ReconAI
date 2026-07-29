"use client";

import { AlertTriangle, CheckCircle2, KeyRound, LoaderCircle, LogIn } from "lucide-react";
import { getSession, signIn } from "next-auth/react";
import { useEffect, useState } from "react";

type AcceptanceState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "accepting" }
  | {
      readonly kind: "accepted";
      readonly organizationId: string;
      readonly role: string;
    }
  | { readonly kind: "error"; readonly message: string };

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export function InvitationAcceptance({ signedIn }: { readonly signedIn: boolean }) {
  const [token, setToken] = useState<string>();
  const [state, setState] = useState<AcceptanceState>({ kind: "loading" });

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const candidate = fragment.get("token");
    if (!candidate || !tokenPattern.test(candidate)) {
      setState({
        kind: "error",
        message: "This invitation link is missing or malformed. Ask the inviter for a new link.",
      });
      return;
    }
    setToken(candidate);
    setState({ kind: "ready" });
    if (signedIn) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, [signedIn]);

  async function acceptInvitation() {
    if (!token || !signedIn) return;
    if (
      !window.confirm(
        "Accept this organization invitation? Your provider-verified email must match the invitation.",
      )
    ) {
      return;
    }
    setState({ kind: "accepting" });
    const session = await getSession();
    if (!session || session.reauthenticationRequired) {
      setState({
        kind: "error",
        message: "Your secure session expired. Sign in again before accepting this invitation.",
      });
      return;
    }
    const response = await fetch("/api/recon/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = (await response.json()) as {
      readonly data?: {
        readonly organizationId?: string;
        readonly role?: string;
      };
      readonly code?: string;
    };
    if (
      !response.ok ||
      typeof body.data?.organizationId !== "string" ||
      typeof body.data.role !== "string"
    ) {
      setToken(undefined);
      setState({
        kind: "error",
        message:
          body.code === "VERIFIED_EMAIL_REQUIRED"
            ? "Your identity provider has not supplied a verified email. Verify it there, sign in again, and request a fresh invitation if needed."
            : "The invitation is invalid, expired, already used, or assigned to a different verified email.",
      });
      return;
    }
    setToken(undefined);
    setState({
      kind: "accepted",
      organizationId: body.data.organizationId,
      role: body.data.role,
    });
  }

  function startSignIn() {
    void signIn("keycloak", { callbackUrl: window.location.href });
  }

  return (
    <main className="invitation-page">
      <section aria-labelledby="accept-invitation-heading" className="invitation-card">
        <div className="invitation-card__mark">
          <KeyRound aria-hidden="true" size={24} />
        </div>
        <p className="eyebrow">Verified organization access</p>
        <h1 id="accept-invitation-heading">Accept invitation</h1>
        <p>
          The link is single use, expires after 72 hours, and is bound to the provider-verified
          email selected by the inviter.
        </p>

        {state.kind === "loading" ? (
          <div aria-busy="true" className="invitation-card__state">
            <LoaderCircle aria-hidden="true" className="spin" size={20} />
            Validating the local invitation link…
          </div>
        ) : null}

        {state.kind === "ready" && !signedIn ? (
          <div className="invitation-card__state">
            <LogIn aria-hidden="true" size={20} />
            <div>
              <strong>Sign in to verify your identity</strong>
              <p>The invitation token remains in the URL fragment and is not sent as a referrer.</p>
            </div>
          </div>
        ) : null}

        {state.kind === "ready" && signedIn ? (
          <div className="invitation-card__state">
            <KeyRound aria-hidden="true" size={20} />
            <div>
              <strong>Identity ready</strong>
              <p>Acceptance creates one active membership and records an immutable audit event.</p>
            </div>
          </div>
        ) : null}

        {state.kind === "accepting" ? (
          <div aria-busy="true" className="invitation-card__state">
            <LoaderCircle aria-hidden="true" className="spin" size={20} />
            Activating tenant-scoped access…
          </div>
        ) : null}

        {state.kind === "accepted" ? (
          <div className="invitation-card__state invitation-card__state--success" role="status">
            <CheckCircle2 aria-hidden="true" size={20} />
            <div>
              <strong>Invitation accepted</strong>
              <p>
                Role: {humanize(state.role)} · Organization:{" "}
                <code>{state.organizationId.slice(0, 8)}</code>
              </p>
            </div>
          </div>
        ) : null}

        {state.kind === "error" ? (
          <div className="invitation-card__state invitation-card__state--error" role="alert">
            <AlertTriangle aria-hidden="true" size={20} />
            <div>
              <strong>Access was not activated</strong>
              <p>{state.message}</p>
            </div>
          </div>
        ) : null}

        <div className="invitation-card__actions">
          {state.kind === "ready" && !signedIn ? (
            <button className="button button--primary" onClick={startSignIn} type="button">
              <LogIn aria-hidden="true" size={14} />
              Sign in securely
            </button>
          ) : null}
          {state.kind === "ready" && signedIn ? (
            <button
              className="button button--primary"
              onClick={() => void acceptInvitation()}
              type="button"
            >
              <CheckCircle2 aria-hidden="true" size={14} />
              Accept access
            </button>
          ) : null}
          {state.kind === "accepted" ? (
            <a className="button button--primary" href="/dashboard">
              Open control desk
            </a>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function humanize(value: string): string {
  const text = value.replaceAll("_", " ").toLocaleLowerCase("en-US");
  return text.charAt(0).toLocaleUpperCase("en-US") + text.slice(1);
}
