"use client";

import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Clipboard,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";

import { SignOutButton } from "./sign-out-button";

const uuid = z.uuid();
const requestResponseSchema = z
  .object({
    data: z
      .object({
        requestCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        requestExpiresAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();
const optionalTimestamp = z.iso.datetime({ offset: true }).optional();
const diagnosticsResponseSchema = z
  .object({
    data: z
      .object({
        schemaVersion: z.literal("support-diagnostics-v1"),
        generatedAt: z.iso.datetime({ offset: true }),
        grantExpiresAt: z.iso.datetime({ offset: true }),
        countsCapped: z.boolean(),
        connections: z
          .object({
            total: z.number().int().nonnegative(),
            nonHealthy: z.number().int().nonnegative(),
            latestSuccessfulSyncAt: optionalTimestamp,
          })
          .strict(),
        providerSyncs: z
          .object({
            active: z.number().int().nonnegative(),
            failed: z.number().int().nonnegative(),
            latestCompletedAt: optionalTimestamp,
          })
          .strict(),
        reconciliations: z
          .object({
            active: z.number().int().nonnegative(),
            failedOrPartial: z.number().int().nonnegative(),
            latestCompletedAt: optionalTimestamp,
          })
          .strict(),
        exceptions: z
          .object({
            unresolved: z.number().int().nonnegative(),
            oldestUnresolvedAt: optionalTimestamp,
          })
          .strict(),
        outbox: z
          .object({
            unpublished: z.number().int().nonnegative(),
            deadLettered: z.number().int().nonnegative(),
            oldestUnpublishedAt: optionalTimestamp,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

type Diagnostics = z.infer<typeof diagnosticsResponseSchema>["data"];
type RequestState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly requestCode: string;
      readonly requestExpiresAt: string;
    }
  | { readonly kind: "error"; readonly message: string };
type DiagnosticsState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly diagnostics: Diagnostics }
  | { readonly kind: "error"; readonly message: string };

const unavailableMessage =
  "Diagnostics are unavailable. Verify the approved identifiers and grant state in the authenticated support ticket.";

export function SupportDiagnosticsConsole() {
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [requestState, setRequestState] = useState<RequestState>({ kind: "idle" });
  const [copyMessage, setCopyMessage] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [grantId, setGrantId] = useState("");
  const [diagnosticsState, setDiagnosticsState] = useState<DiagnosticsState>({ kind: "idle" });

  const validDiagnosticAuthority =
    uuid.safeParse(organizationId.trim()).success && uuid.safeParse(grantId.trim()).success;

  async function createRequest() {
    setRequestState({ kind: "loading" });
    setCopyMessage("");
    try {
      const response = await fetch("/api/recon/support", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create_request",
          requestedDurationMinutes: durationMinutes,
        }),
      });
      const raw: unknown = await response.json();
      const parsed = requestResponseSchema.safeParse(raw);
      if (!response.ok || !parsed.success) {
        setRequestState({
          kind: "error",
          message: "A restricted support request could not be created.",
        });
        return;
      }
      setRequestState({ kind: "ready", ...parsed.data.data });
    } catch {
      setRequestState({
        kind: "error",
        message: "The restricted support service is unavailable.",
      });
    }
  }

  async function copyRequestCode() {
    if (requestState.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(requestState.requestCode);
      setCopyMessage("Request code copied. Keep it only in the authenticated support ticket.");
    } catch {
      setCopyMessage("Copy was blocked. Select the code and copy it manually.");
    }
  }

  async function loadDiagnostics() {
    if (!validDiagnosticAuthority) return;
    setDiagnosticsState({ kind: "loading" });
    const query = new URLSearchParams({
      organizationId: organizationId.trim(),
      grantId: grantId.trim(),
    });
    try {
      const response = await fetch(`/api/recon/support?${query.toString()}`, {
        cache: "no-store",
      });
      const raw: unknown = await response.json();
      const parsed = diagnosticsResponseSchema.safeParse(raw);
      if (!response.ok || !parsed.success) {
        setDiagnosticsState({ kind: "error", message: unavailableMessage });
        return;
      }
      setDiagnosticsState({ kind: "ready", diagnostics: parsed.data.data });
    } catch {
      setDiagnosticsState({ kind: "error", message: unavailableMessage });
    }
  }

  return (
    <div className="support-console">
      <header className="support-console__header">
        <Link className="wordmark" href="/">
          <span className="wordmark__mark" aria-hidden="true">
            R
          </span>
          <span>
            ReconAI
            <small>Restricted support</small>
          </span>
        </Link>
        <div className="support-console__header-actions">
          <Link className="support-back-link" href="/dashboard">
            <ArrowLeft aria-hidden="true" size={15} />
            Control desk
          </Link>
          <SignOutButton />
        </div>
      </header>

      <main className="support-console__main">
        <section className="support-console__heading">
          <div>
            <p className="eyebrow">Organization-blind diagnostic boundary</p>
            <h1>Restricted support console</h1>
            <p>
              Request tenant approval, then inspect only fixed, read-only aggregates named in the
              authenticated ticket. This console has no organization directory or search.
            </p>
          </div>
          <span className="support-boundary-label">
            <LockKeyhole aria-hidden="true" size={14} />
            Explicit grant required
          </span>
        </section>

        <div className="support-assurance" role="note">
          <ShieldCheck aria-hidden="true" size={21} />
          <div>
            <strong>Restricted group membership and MFA are enforced upstream.</strong>
            <p>
              Every request, diagnostic read, denial, expiry, and revocation is audit-visible.
              Grants expose aggregate health only and cannot write tenant or source-system data.
            </p>
          </div>
        </div>

        <div className="support-console__grid">
          <section aria-labelledby="support-request-heading" className="support-workbench">
            <div className="support-workbench__heading">
              <span>01</span>
              <div>
                <p className="eyebrow">Request tenant approval</p>
                <h2 id="support-request-heading">Create a short-lived request</h2>
                <p>The tenant owner chooses whether to approve it and for how long.</p>
              </div>
            </div>
            <div className="support-form">
              <label htmlFor="support-duration">
                Requested diagnostic window · minutes
                <input
                  id="support-duration"
                  max={60}
                  min={5}
                  onChange={(event) => {
                    setDurationMinutes(Number(event.target.value));
                    setRequestState({ kind: "idle" });
                    setCopyMessage("");
                  }}
                  type="number"
                  value={durationMinutes}
                />
                <small>
                  Allowed range: 5–60 minutes. The approval request expires in 15 minutes.
                </small>
              </label>
              <button
                className="button button--primary"
                disabled={
                  requestState.kind === "loading" ||
                  !Number.isInteger(durationMinutes) ||
                  durationMinutes < 5 ||
                  durationMinutes > 60
                }
                onClick={() => void createRequest()}
                type="button"
              >
                {requestState.kind === "loading" ? (
                  <LoaderCircle aria-hidden="true" className="spin" size={16} />
                ) : (
                  <KeyRound aria-hidden="true" size={16} />
                )}
                Create approval request
              </button>
              <div aria-live="polite">
                {requestState.kind === "error" ? (
                  <div className="support-inline-state support-inline-state--error" role="alert">
                    <AlertTriangle aria-hidden="true" size={17} />
                    {requestState.message}
                  </div>
                ) : null}
                {requestState.kind === "ready" ? (
                  <div className="support-request-code">
                    <div>
                      <BadgeCheck aria-hidden="true" size={17} />
                      <strong>Transfer this code through the authenticated support ticket.</strong>
                    </div>
                    <label htmlFor="support-request-code">
                      One-time request code
                      <input
                        id="support-request-code"
                        readOnly
                        spellCheck={false}
                        value={requestState.requestCode}
                      />
                    </label>
                    <p>
                      Expires <time>{formatTimestamp(requestState.requestExpiresAt)}</time>. The
                      code exists only in this page&apos;s memory and will not survive navigation.
                    </p>
                    <div className="support-code-actions">
                      <button
                        className="button button--secondary"
                        onClick={() => void copyRequestCode()}
                        type="button"
                      >
                        <Clipboard aria-hidden="true" size={15} />
                        Copy code
                      </button>
                      <button
                        className="button button--secondary"
                        onClick={() => {
                          setRequestState({ kind: "idle" });
                          setCopyMessage("");
                        }}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={15} />
                        Clear code
                      </button>
                    </div>
                    <p aria-live="polite" className="support-copy-state">
                      {copyMessage}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section aria-labelledby="support-diagnostics-heading" className="support-workbench">
            <div className="support-workbench__heading">
              <span>02</span>
              <div>
                <p className="eyebrow">Use approved authority</p>
                <h2 id="support-diagnostics-heading">Load bounded diagnostics</h2>
                <p>Enter both identifiers exactly as recorded in the approved ticket.</p>
              </div>
            </div>
            <div className="support-form">
              <label htmlFor="support-organization-id">
                Organization ID
                <input
                  autoComplete="off"
                  id="support-organization-id"
                  onChange={(event) => {
                    setOrganizationId(event.target.value);
                    setDiagnosticsState({ kind: "idle" });
                  }}
                  spellCheck={false}
                  value={organizationId}
                />
              </label>
              <label htmlFor="support-grant-id">
                Grant ID
                <input
                  autoComplete="off"
                  id="support-grant-id"
                  onChange={(event) => {
                    setGrantId(event.target.value);
                    setDiagnosticsState({ kind: "idle" });
                  }}
                  spellCheck={false}
                  value={grantId}
                />
              </label>
              <button
                className="button button--primary"
                disabled={!validDiagnosticAuthority || diagnosticsState.kind === "loading"}
                onClick={() => void loadDiagnostics()}
                type="button"
              >
                {diagnosticsState.kind === "loading" ? (
                  <LoaderCircle aria-hidden="true" className="spin" size={16} />
                ) : (
                  <Search aria-hidden="true" size={16} />
                )}
                Load approved diagnostics
              </button>
              {diagnosticsState.kind === "error" ? (
                <div className="support-inline-state support-inline-state--error" role="alert">
                  <AlertTriangle aria-hidden="true" size={17} />
                  {diagnosticsState.message}
                </div>
              ) : null}
            </div>
          </section>
        </div>

        {diagnosticsState.kind === "ready" ? (
          <DiagnosticsLedger diagnostics={diagnosticsState.diagnostics} />
        ) : null}
      </main>
    </div>
  );
}

function DiagnosticsLedger({ diagnostics }: { readonly diagnostics: Diagnostics }) {
  const rows = [
    {
      label: "Connections",
      primary: diagnostics.connections.total,
      primaryLabel: "total",
      secondary: diagnostics.connections.nonHealthy,
      secondaryLabel: "not healthy",
      timestamp: diagnostics.connections.latestSuccessfulSyncAt,
      timestampLabel: "Latest successful sync",
    },
    {
      label: "Provider syncs",
      primary: diagnostics.providerSyncs.active,
      primaryLabel: "active",
      secondary: diagnostics.providerSyncs.failed,
      secondaryLabel: "failed",
      timestamp: diagnostics.providerSyncs.latestCompletedAt,
      timestampLabel: "Latest completed",
    },
    {
      label: "Reconciliations",
      primary: diagnostics.reconciliations.active,
      primaryLabel: "active",
      secondary: diagnostics.reconciliations.failedOrPartial,
      secondaryLabel: "failed or partial",
      timestamp: diagnostics.reconciliations.latestCompletedAt,
      timestampLabel: "Latest completed",
    },
    {
      label: "Exceptions",
      primary: diagnostics.exceptions.unresolved,
      primaryLabel: "unresolved",
      secondary: undefined,
      secondaryLabel: "",
      timestamp: diagnostics.exceptions.oldestUnresolvedAt,
      timestampLabel: "Oldest unresolved",
    },
    {
      label: "Outbox",
      primary: diagnostics.outbox.unpublished,
      primaryLabel: "unpublished",
      secondary: diagnostics.outbox.deadLettered,
      secondaryLabel: "dead-lettered",
      timestamp: diagnostics.outbox.oldestUnpublishedAt,
      timestampLabel: "Oldest unpublished",
    },
  ] as const;

  return (
    <section aria-labelledby="diagnostics-ledger-heading" className="support-ledger">
      <div className="support-ledger__heading">
        <div>
          <p className="eyebrow">Read-only aggregate result</p>
          <h2 id="diagnostics-ledger-heading">Approved diagnostic ledger</h2>
        </div>
        <dl>
          <div>
            <dt>Generated</dt>
            <dd>
              <time dateTime={diagnostics.generatedAt}>
                {formatTimestamp(diagnostics.generatedAt)}
              </time>
            </dd>
          </div>
          <div>
            <dt>Grant expires</dt>
            <dd>
              <time dateTime={diagnostics.grantExpiresAt}>
                {formatTimestamp(diagnostics.grantExpiresAt)}
              </time>
            </dd>
          </div>
        </dl>
      </div>
      {diagnostics.countsCapped ? (
        <div className="support-cap-warning" role="note">
          Counts reached a diagnostic cap; treat them as lower bounds.
        </div>
      ) : null}
      <div className="support-ledger__rows">
        {rows.map((row) => (
          <article key={row.label}>
            <h3>{row.label}</h3>
            <div className="support-ledger__counts">
              <span>
                <strong>{row.primary}</strong>
                <small>{row.primaryLabel}</small>
              </span>
              {row.secondary === undefined ? null : (
                <span>
                  <strong>{row.secondary}</strong>
                  <small>{row.secondaryLabel}</small>
                </span>
              )}
            </div>
            <p>
              {row.timestampLabel}:{" "}
              {row.timestamp ? (
                <time dateTime={row.timestamp}>{formatTimestamp(row.timestamp)}</time>
              ) : (
                "No recorded timestamp"
              )}
            </p>
          </article>
        ))}
      </div>
    </section>
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
