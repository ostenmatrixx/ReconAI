"use client";

import {
  AlertTriangle,
  BadgeCheck,
  Ban,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

const supportGrantSchema = z
  .object({
    id: z.uuid(),
    supportIdentityReference: z.string().regex(/^[a-f0-9]{12}$/u),
    capability: z.literal("diagnostics:view"),
    ticketReference: z.string().min(3).max(200),
    reason: z.string().min(3).max(2000),
    approvedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    status: z.enum(["active", "expired", "revoked"]),
    revokedAt: z.iso.datetime({ offset: true }).optional(),
    revocationReason: z.string().min(3).max(2000).optional(),
  })
  .strict();
const listResponseSchema = z.object({ data: z.array(supportGrantSchema).max(50) }).strict();

type SupportGrant = z.infer<typeof supportGrantSchema>;
type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly grants: readonly SupportGrant[] };
type MutationState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving"; readonly grantId?: string }
  | { readonly kind: "success"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

export function SupportAccessGrants() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [requestCode, setRequestCode] = useState("");
  const [ticketReference, setTicketReference] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [mutation, setMutation] = useState<MutationState>({ kind: "idle" });
  const [revocationReason, setRevocationReason] = useState<Record<string, string>>({});
  const [revocationConfirmed, setRevocationConfirmed] = useState<Record<string, boolean>>({});

  const loadGrants = useCallback(async () => {
    try {
      const response = await fetch("/api/recon?view=support_access_grants", {
        cache: "no-store",
      });
      const raw: unknown = await response.json();
      const parsed = listResponseSchema.safeParse(raw);
      if (!response.ok || !parsed.success) {
        setState({ kind: "unavailable" });
        return;
      }
      setState({ kind: "ready", grants: parsed.data.data });
    } catch {
      setState({ kind: "unavailable" });
    }
  }, []);

  useEffect(() => {
    void loadGrants();
  }, [loadGrants]);

  const canApprove =
    /^[A-Za-z0-9_-]{43}$/u.test(requestCode) &&
    ticketReference.trim().length >= 3 &&
    reason.trim().length >= 3 &&
    confirmed &&
    mutation.kind !== "saving";

  function resetMutation() {
    setMutation({ kind: "idle" });
  }

  async function approveAccess() {
    if (!canApprove) return;
    const submittedRequestCode = requestCode;
    setRequestCode("");
    setMutation({ kind: "saving" });
    try {
      const response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "approve_support_access",
          requestCode: submittedRequestCode,
          ticketReference: ticketReference.trim(),
          reason: reason.trim(),
          confirmed: true,
        }),
      });
      if (!response.ok) {
        setMutation({
          kind: "error",
          message: "Support access was not approved. Verify the request code and tenant authority.",
        });
        return;
      }
      setTicketReference("");
      setReason("");
      setConfirmed(false);
      setMutation({
        kind: "success",
        message: "Restricted diagnostic access approved and recorded in audit history.",
      });
      await loadGrants();
    } catch {
      setMutation({ kind: "error", message: "The support-access service is unavailable." });
    }
  }

  async function revokeAccess(grantId: string) {
    const submittedReason = revocationReason[grantId]?.trim() ?? "";
    if (submittedReason.length < 3 || !revocationConfirmed[grantId] || mutation.kind === "saving") {
      return;
    }
    setMutation({ kind: "saving", grantId });
    try {
      const response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "revoke_support_access",
          grantId,
          reason: submittedReason,
          confirmed: true,
        }),
      });
      if (!response.ok) {
        setMutation({
          kind: "error",
          message: "The selected support grant could not be revoked.",
        });
        return;
      }
      setRevocationReason((current) => ({ ...current, [grantId]: "" }));
      setRevocationConfirmed((current) => ({ ...current, [grantId]: false }));
      setMutation({
        kind: "success",
        message: "Restricted diagnostic access revoked and recorded in audit history.",
      });
      await loadGrants();
    } catch {
      setMutation({ kind: "error", message: "The support-access service is unavailable." });
    }
  }

  return (
    <section aria-labelledby="support-access-heading" className="queue-panel support-access-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Tenant-owned access boundary</p>
          <h2 id="support-access-heading">Restricted support access</h2>
          <p>
            Organization owners may approve short-lived, aggregate-only diagnostics for an
            authenticated support identity. Approval never grants data writes or tenant discovery.
          </p>
        </div>
        <span className="source-boundary">
          <ShieldCheck aria-hidden="true" size={14} />
          Owner managed
        </span>
      </div>

      {state.kind === "loading" ? (
        <div aria-busy="true" className="workspace-loading">
          <LoaderCircle aria-hidden="true" className="spin" size={22} />
          Loading restricted support controls…
        </div>
      ) : null}

      {state.kind === "unavailable" ? (
        <div className="state-panel" role="status">
          <LockKeyhole aria-hidden="true" size={22} />
          <div>
            <strong>Restricted support controls unavailable</strong>
            <p>
              The selected organization does not expose this owner-only control to the current
              session. No organization or grant details were disclosed.
            </p>
          </div>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <>
          <div className="support-access-approval">
            <div className="support-assurance" role="note">
              <KeyRound aria-hidden="true" size={20} />
              <div>
                <strong>Approve only a code received in the authenticated support ticket.</strong>
                <p>
                  Confirm the selected organization shown in the navigation. The request code is
                  cleared from this form as soon as approval is submitted.
                </p>
              </div>
            </div>
            <div className="support-access-form">
              <div className="support-access-form__grid">
                <label htmlFor="tenant-support-request-code">
                  One-time request code
                  <input
                    autoComplete="off"
                    id="tenant-support-request-code"
                    maxLength={43}
                    onChange={(event) => {
                      setRequestCode(event.target.value);
                      resetMutation();
                    }}
                    spellCheck={false}
                    value={requestCode}
                  />
                </label>
                <label htmlFor="tenant-support-ticket">
                  Support ticket reference
                  <input
                    id="tenant-support-ticket"
                    maxLength={200}
                    onChange={(event) => {
                      setTicketReference(event.target.value);
                      resetMutation();
                    }}
                    value={ticketReference}
                  />
                </label>
              </div>
              <label htmlFor="tenant-support-reason">
                Approval reason · audit-visible
                <textarea
                  id="tenant-support-reason"
                  maxLength={2000}
                  onChange={(event) => {
                    setReason(event.target.value);
                    resetMutation();
                  }}
                  rows={3}
                  value={reason}
                />
              </label>
              <label className="policy-confirmation">
                <input
                  checked={confirmed}
                  onChange={(event) => {
                    setConfirmed(event.target.checked);
                    resetMutation();
                  }}
                  type="checkbox"
                />
                <span>
                  I confirm this request belongs to the currently selected organization and may
                  expose bounded operational aggregates for at most 60 minutes.
                </span>
              </label>
              <button
                className="button button--primary"
                disabled={!canApprove}
                onClick={() => void approveAccess()}
                type="button"
              >
                {mutation.kind === "saving" && !mutation.grantId ? (
                  <LoaderCircle aria-hidden="true" className="spin" size={15} />
                ) : (
                  <BadgeCheck aria-hidden="true" size={15} />
                )}
                Approve restricted access
              </button>
            </div>
          </div>

          <div aria-live="polite">
            {mutation.kind === "success" ? (
              <div className="support-mutation-state">
                <BadgeCheck aria-hidden="true" size={16} />
                {mutation.message}
              </div>
            ) : null}
            {mutation.kind === "error" ? (
              <div className="support-mutation-state support-mutation-state--error" role="alert">
                <AlertTriangle aria-hidden="true" size={16} />
                {mutation.message}
              </div>
            ) : null}
          </div>

          <div className="support-grant-history">
            <div className="support-grant-history__heading">
              <div>
                <h3>Grant history</h3>
                <p>Bounded to the 50 most recent grants for this organization.</p>
              </div>
              <button
                aria-label="Refresh support grants"
                className="icon-button"
                onClick={() => {
                  setState({ kind: "loading" });
                  void loadGrants();
                }}
                title="Refresh support grants"
                type="button"
              >
                <RefreshCw aria-hidden="true" size={15} />
              </button>
            </div>
            {state.grants.length === 0 ? (
              <div className="state-panel">
                <ShieldCheck aria-hidden="true" size={22} />
                <div>
                  <strong>No restricted support grants</strong>
                  <p>This organization has not approved diagnostic access.</p>
                </div>
              </div>
            ) : (
              <div className="support-grant-list">
                {state.grants.map((grant) => (
                  <GrantRecord
                    grant={grant}
                    isSaving={mutation.kind === "saving" && mutation.grantId === grant.id}
                    key={grant.id}
                    onConfirmed={(value) =>
                      setRevocationConfirmed((current) => ({ ...current, [grant.id]: value }))
                    }
                    onReason={(value) =>
                      setRevocationReason((current) => ({ ...current, [grant.id]: value }))
                    }
                    onRevoke={() => void revokeAccess(grant.id)}
                    reason={revocationReason[grant.id] ?? ""}
                    revocationConfirmed={revocationConfirmed[grant.id] ?? false}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

function GrantRecord({
  grant,
  isSaving,
  onConfirmed,
  onReason,
  onRevoke,
  reason,
  revocationConfirmed,
}: {
  readonly grant: SupportGrant;
  readonly isSaving: boolean;
  readonly onConfirmed: (value: boolean) => void;
  readonly onReason: (value: string) => void;
  readonly onRevoke: () => void;
  readonly reason: string;
  readonly revocationConfirmed: boolean;
}) {
  return (
    <article className="support-grant-record">
      <div className="support-grant-record__summary">
        <div>
          <span className={`support-status support-status--${grant.status}`}>{grant.status}</span>
          <h4>{grant.ticketReference}</h4>
          <code>Support identity {grant.supportIdentityReference}</code>
        </div>
        <dl>
          <div>
            <dt>Approved</dt>
            <dd>
              <time dateTime={grant.approvedAt}>{formatTimestamp(grant.approvedAt)}</time>
            </dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>
              <time dateTime={grant.expiresAt}>{formatTimestamp(grant.expiresAt)}</time>
            </dd>
          </div>
          {grant.revokedAt ? (
            <div>
              <dt>Revoked</dt>
              <dd>
                <time dateTime={grant.revokedAt}>{formatTimestamp(grant.revokedAt)}</time>
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="support-grant-record__reason">
        <strong>Approval reason</strong>
        <p>{grant.reason}</p>
        {grant.revocationReason ? (
          <>
            <strong>Revocation reason</strong>
            <p>{grant.revocationReason}</p>
          </>
        ) : null}
      </div>
      {grant.status !== "revoked" ? (
        <div className="support-revoke-form">
          <label htmlFor={`revoke-reason-${grant.id}`}>
            Revocation reason · audit-visible
            <input
              id={`revoke-reason-${grant.id}`}
              maxLength={2000}
              onChange={(event) => onReason(event.target.value)}
              value={reason}
            />
          </label>
          <label className="policy-confirmation">
            <input
              checked={revocationConfirmed}
              onChange={(event) => onConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>I confirm this grant must no longer authorize diagnostics.</span>
          </label>
          <button
            className="button button--danger"
            disabled={reason.trim().length < 3 || !revocationConfirmed || isSaving}
            onClick={onRevoke}
            type="button"
          >
            {isSaving ? (
              <LoaderCircle aria-hidden="true" className="spin" size={15} />
            ) : (
              <Ban aria-hidden="true" size={15} />
            )}
            Revoke access
          </button>
        </div>
      ) : null}
    </article>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(date) + " UTC";
}
