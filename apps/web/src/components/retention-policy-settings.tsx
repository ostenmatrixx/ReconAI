"use client";

import {
  AlertTriangle,
  Archive,
  BadgeCheck,
  LoaderCircle,
  LockKeyhole,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface RetentionPolicy {
  readonly rawImportRetentionDays: number | null;
  readonly providerEventRetentionDays: number | null;
  readonly legalHoldEnabled: boolean;
  readonly legalHoldReason: string | null;
  readonly updatedAt: string | null;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly policy: RetentionPolicy };

export function RetentionPolicySettings() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [rawImportDays, setRawImportDays] = useState("");
  const [providerEventDays, setProviderEventDays] = useState("");
  const [legalHoldEnabled, setLegalHoldEnabled] = useState(false);
  const [legalHoldReason, setLegalHoldReason] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/recon?view=retention_policy", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: RetentionPolicy;
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setState({
            kind: "error",
            message: body.message ?? "Retention policy could not be loaded.",
          });
          return;
        }
        applyPolicy(body.data);
        setState({ kind: "ready", policy: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "The retention policy API is unavailable." });
      });
    return () => controller.abort();
  }, []);

  const draft = useMemo(
    () =>
      parseRetentionDraft({
        rawImportDays,
        providerEventDays,
        legalHoldEnabled,
        legalHoldReason,
      }),
    [legalHoldEnabled, legalHoldReason, providerEventDays, rawImportDays],
  );
  const canSave =
    state.kind === "ready" &&
    draft.ok &&
    reason.trim().length >= 3 &&
    confirmed &&
    saveState !== "saving";

  function applyPolicy(policy: RetentionPolicy) {
    setRawImportDays(policy.rawImportRetentionDays?.toString() ?? "");
    setProviderEventDays(policy.providerEventRetentionDays?.toString() ?? "");
    setLegalHoldEnabled(policy.legalHoldEnabled);
    setLegalHoldReason(policy.legalHoldReason ?? "");
  }

  function resetSaveState() {
    setSaveState("idle");
    setSaveMessage("");
    setConfirmed(false);
  }

  async function savePolicy() {
    if (!draft.ok) return;
    if (!canSave) return;
    setSaveState("saving");
    setSaveMessage("");
    try {
      const response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "update_retention_policy",
          rawImportRetentionDays: draft.rawImportRetentionDays,
          providerEventRetentionDays: draft.providerEventRetentionDays,
          legalHoldEnabled,
          legalHoldReason: legalHoldEnabled ? legalHoldReason.trim() : null,
          confirmed: true,
          reason,
        }),
      });
      const body = (await response.json()) as {
        readonly data?: RetentionPolicy;
        readonly message?: string;
      };
      if (!response.ok || !body.data) {
        setSaveState("failed");
        setSaveMessage(body.message ?? "Retention policy was not updated.");
        return;
      }
      applyPolicy(body.data);
      setState({ kind: "ready", policy: body.data });
      setReason("");
      setConfirmed(false);
      setSaveState("saved");
      setSaveMessage("Retention policy updated and recorded in the audit history.");
    } catch {
      setSaveState("failed");
      setSaveMessage("The retention policy API is unavailable.");
    }
  }

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Destructive data-lifecycle boundary</p>
          <h1>Security & retention</h1>
          <p>
            Raw-object deletion is disabled until an authorized organization policy is recorded.
            Legal hold pauses every retention deletion for this organization.
          </p>
        </div>
        <span className="source-boundary">
          <ShieldCheck aria-hidden="true" size={14} />
          Canonical evidence retained
        </span>
      </section>
      <section className="policy-panel">
        {state.kind === "loading" ? (
          <div aria-busy="true" className="workspace-loading">
            <LoaderCircle aria-hidden="true" className="spin" size={22} />
            Loading retention controls…
          </div>
        ) : null}
        {state.kind === "error" ? (
          <div className="state-panel state-panel--error" role="alert">
            <AlertTriangle aria-hidden="true" size={22} />
            <div>
              <strong>Retention controls unavailable</strong>
              <p>{state.message}</p>
            </div>
          </div>
        ) : null}
        {state.kind === "ready" ? (
          <>
            <div className="policy-panel__heading">
              <div>
                <p className="eyebrow">Current organization policy</p>
                <h2>Raw evidence lifecycle</h2>
                <p>
                  Blank durations disable that deletion class. The worker considers only completed
                  or rolled-back CSV imports and processed provider events.
                </p>
              </div>
              <span>
                {state.policy.updatedAt ? (
                  <>
                    Updated
                    <time dateTime={state.policy.updatedAt}>
                      {formatTimestamp(state.policy.updatedAt)}
                    </time>
                  </>
                ) : (
                  "Not configured"
                )}
              </span>
            </div>
            <div className="policy-form">
              <div className="retention-warning" role="note">
                <Archive aria-hidden="true" size={20} />
                <div>
                  <strong>Raw-object deletion is permanent in an unversioned bucket.</strong>
                  <p>
                    Import/source metadata, checksums, canonical records, field provenance, audit
                    events, and immutable deletion tombstones remain. Backups and versioned-object
                    lifecycle rules must be configured separately.
                  </p>
                </div>
              </div>

              <fieldset>
                <legend>Retention durations</legend>
                <p>
                  Enter an approved whole-day duration from 1 to 3,650. Leave a field blank to keep
                  that raw object class indefinitely.
                </p>
                <div className="retention-days-grid">
                  <label>
                    Raw accounting import · days
                    <input
                      inputMode="numeric"
                      max={3650}
                      min={1}
                      onChange={(event) => {
                        setRawImportDays(event.target.value);
                        resetSaveState();
                      }}
                      placeholder="Disabled"
                      type="number"
                      value={rawImportDays}
                    />
                    <small>Applies after a CSV import succeeds or is rolled back.</small>
                  </label>
                  <label>
                    Provider event payload · days
                    <input
                      inputMode="numeric"
                      max={3650}
                      min={1}
                      onChange={(event) => {
                        setProviderEventDays(event.target.value);
                        resetSaveState();
                      }}
                      placeholder="Disabled"
                      type="number"
                      value={providerEventDays}
                    />
                    <small>Applies only after a provider event is processed or normalized.</small>
                  </label>
                </div>
              </fieldset>

              <label className="policy-toggle">
                <input
                  checked={legalHoldEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setLegalHoldEnabled(enabled);
                    if (!enabled) setLegalHoldReason("");
                    resetSaveState();
                  }}
                  type="checkbox"
                />
                <span>
                  <strong>Enable legal hold</strong>
                  <small>
                    Blocks all organization retention deletions. Enabling a hold requires a durable,
                    audit-visible hold reason.
                  </small>
                </span>
              </label>

              {legalHoldEnabled ? (
                <label>
                  Legal-hold reason · required
                  <textarea
                    maxLength={2000}
                    onChange={(event) => {
                      setLegalHoldReason(event.target.value);
                      resetSaveState();
                    }}
                    rows={3}
                    value={legalHoldReason}
                  />
                  <small>Do not include privileged case details that do not belong in audit.</small>
                </label>
              ) : null}

              <label>
                Change reason · required and audit-visible
                <textarea
                  maxLength={2000}
                  onChange={(event) => {
                    setReason(event.target.value);
                    resetSaveState();
                  }}
                  rows={3}
                  value={reason}
                />
              </label>

              {!draft.ok ? (
                <div className="form-validation" role="alert">
                  <AlertTriangle aria-hidden="true" size={15} />
                  {draft.message}
                </div>
              ) : null}

              <label className="policy-confirmation">
                <input
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  I confirm these durations may permanently delete eligible raw objects and that the
                  legal-hold state is correct.
                </span>
              </label>

              <div className="policy-actions">
                <button
                  className="button button--primary"
                  disabled={!canSave}
                  onClick={() => void savePolicy()}
                  type="button"
                >
                  {saveState === "saving" ? (
                    <LoaderCircle aria-hidden="true" className="spin" size={15} />
                  ) : (
                    <Save aria-hidden="true" size={15} />
                  )}
                  Save retention policy
                </button>
                <div aria-live="polite" className={`policy-save-state ${saveState}`}>
                  {saveState === "saved" ? <BadgeCheck aria-hidden="true" size={16} /> : null}
                  {saveState === "failed" ? <AlertTriangle aria-hidden="true" size={16} /> : null}
                  {saveMessage}
                </div>
              </div>

              {legalHoldEnabled ? (
                <div className="retention-hold-state" role="status">
                  <LockKeyhole aria-hidden="true" size={16} />
                  Legal hold is active in this draft; the worker will not claim organization
                  objects.
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </section>
    </>
  );
}

type RetentionDraft =
  | {
      readonly ok: true;
      readonly rawImportRetentionDays: number | null;
      readonly providerEventRetentionDays: number | null;
    }
  | { readonly ok: false; readonly message: string };

function parseRetentionDraft(input: {
  readonly rawImportDays: string;
  readonly providerEventDays: string;
  readonly legalHoldEnabled: boolean;
  readonly legalHoldReason: string;
}): RetentionDraft {
  const rawImportRetentionDays = parseDays(input.rawImportDays);
  const providerEventRetentionDays = parseDays(input.providerEventDays);
  if (rawImportRetentionDays === undefined || providerEventRetentionDays === undefined) {
    return { ok: false, message: "Retention durations must be whole days from 1 to 3,650." };
  }
  if (input.legalHoldEnabled && input.legalHoldReason.trim().length < 3) {
    return { ok: false, message: "A legal hold requires a reason of at least 3 characters." };
  }
  return { ok: true, rawImportRetentionDays, providerEventRetentionDays };
}

function parseDays(value: string): number | null | undefined {
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^[0-9]{1,4}$/u.test(normalized)) return undefined;
  const days = Number(normalized);
  return Number.isSafeInteger(days) && days >= 1 && days <= 3650 ? days : undefined;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
