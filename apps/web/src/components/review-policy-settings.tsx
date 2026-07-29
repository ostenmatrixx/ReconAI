"use client";

import {
  AlertTriangle,
  BadgeCheck,
  LoaderCircle,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface ReviewPolicy {
  readonly dualApprovalEnabled: boolean;
  readonly dualApprovalThresholds: Readonly<Record<string, string>>;
  readonly sensitiveResolutionTypes: readonly string[];
  readonly updatedAt: string;
}

interface ThresholdDraft {
  readonly id: string;
  readonly currency: string;
  readonly amountMinor: string;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly policy: ReviewPolicy };

export function ReviewPolicySettings() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [dualApprovalEnabled, setDualApprovalEnabled] = useState(true);
  const [thresholds, setThresholds] = useState<readonly ThresholdDraft[]>([]);
  const [sensitiveTypes, setSensitiveTypes] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/recon?view=review_policy", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: ReviewPolicy;
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setState({
            kind: "error",
            message: body.message ?? "Review policy could not be loaded.",
          });
          return;
        }
        applyPolicy(body.data);
        setState({ kind: "ready", policy: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "The review policy API is unavailable." });
      });
    return () => controller.abort();
  }, []);

  const parsedPolicy = useMemo(
    () => parsePolicyDraft(thresholds, sensitiveTypes),
    [sensitiveTypes, thresholds],
  );
  const canAttemptSave =
    state.kind === "ready" && reason.trim().length >= 3 && confirmed && saveState !== "saving";
  const canSave = canAttemptSave && parsedPolicy.ok;

  function applyPolicy(policy: ReviewPolicy) {
    setDualApprovalEnabled(policy.dualApprovalEnabled);
    setThresholds(
      Object.entries(policy.dualApprovalThresholds)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([currency, amountMinor]) => ({
          id: `persisted:${currency}`,
          currency,
          amountMinor,
        })),
    );
    setSensitiveTypes(policy.sensitiveResolutionTypes.join(", "));
  }

  function updateThreshold(id: string, field: "currency" | "amountMinor", value: string) {
    setThresholds((current) =>
      current.map((threshold) =>
        threshold.id === id
          ? {
              ...threshold,
              [field]: field === "currency" ? value.toLocaleUpperCase("en-US") : value,
            }
          : threshold,
      ),
    );
    setSaveState("idle");
    setSaveMessage("");
  }

  async function savePolicy() {
    if (!canAttemptSave || !parsedPolicy.ok) return;
    setSaveState("saving");
    setSaveMessage("");
    try {
      const response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "update_review_policy",
          dualApprovalEnabled,
          dualApprovalThresholds: parsedPolicy.thresholds,
          sensitiveResolutionTypes: parsedPolicy.sensitiveTypes,
          reason,
        }),
      });
      const body = (await response.json()) as {
        readonly data?: ReviewPolicy;
        readonly message?: string;
      };
      if (!response.ok || !body.data) {
        setSaveState("failed");
        setSaveMessage(body.message ?? "Review policy was not updated.");
        return;
      }
      applyPolicy(body.data);
      setState({ kind: "ready", policy: body.data });
      setReason("");
      setConfirmed(false);
      setSaveState("saved");
      setSaveMessage("Review policy updated and recorded in the audit history.");
    } catch {
      setSaveState("failed");
      setSaveMessage("The review policy API is unavailable.");
    }
  }

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Versioned human-control boundary</p>
          <h1>Rules & tolerances</h1>
          <p>
            Configure when resolution proposals require independent dual approval. Reconciliation
            amount and time tolerances remain explicitly pinned to each run.
          </p>
        </div>
        <span className="source-boundary">
          <ShieldCheck aria-hidden="true" size={14} />
          No automatic write-back
        </span>
      </section>
      <section className="policy-panel">
        {state.kind === "loading" ? (
          <div aria-busy="true" className="workspace-loading">
            <LoaderCircle aria-hidden="true" className="spin" size={22} />
            Loading review controls…
          </div>
        ) : null}
        {state.kind === "error" ? (
          <div className="state-panel state-panel--error" role="alert">
            <AlertTriangle aria-hidden="true" size={22} />
            <div>
              <strong>Review controls unavailable</strong>
              <p>{state.message}</p>
            </div>
          </div>
        ) : null}
        {state.kind === "ready" ? (
          <>
            <div className="policy-panel__heading">
              <div>
                <p className="eyebrow">Current organization policy</p>
                <h2>Independent approval requirements</h2>
                <p>
                  Thresholds are entered as integer minor units. For example, USD 100000 means
                  $1,000.00. Currency conversion is never implied.
                </p>
              </div>
              <span>
                Updated{" "}
                <time dateTime={state.policy.updatedAt}>
                  {formatTimestamp(state.policy.updatedAt)}
                </time>
              </span>
            </div>
            <div className="policy-form">
              <label className="policy-toggle">
                <input
                  checked={dualApprovalEnabled}
                  onChange={(event) => {
                    setDualApprovalEnabled(event.target.checked);
                    setSaveState("idle");
                  }}
                  type="checkbox"
                />
                <span>
                  <strong>Enable dual approval</strong>
                  <small>
                    Sensitive resolution types and configured amount thresholds require two
                    independent reviewers.
                  </small>
                </span>
              </label>

              <fieldset>
                <legend>Amount thresholds by currency</legend>
                <p>
                  A proposal at or above a configured amount requires dual approval. Leave a
                  currency absent when no amount threshold has been approved.
                </p>
                <div className="threshold-list">
                  {thresholds.map((threshold) => (
                    <div className="threshold-row" key={threshold.id}>
                      <label>
                        Currency
                        <input
                          aria-label={`Currency for threshold ${threshold.id}`}
                          inputMode="text"
                          maxLength={3}
                          onChange={(event) =>
                            updateThreshold(threshold.id, "currency", event.target.value)
                          }
                          placeholder="USD"
                          value={threshold.currency}
                        />
                      </label>
                      <label>
                        Amount · minor units
                        <input
                          aria-label={`Amount in minor units for ${threshold.currency || "new currency"}`}
                          inputMode="numeric"
                          maxLength={31}
                          onChange={(event) =>
                            updateThreshold(threshold.id, "amountMinor", event.target.value)
                          }
                          placeholder="100000"
                          value={threshold.amountMinor}
                        />
                      </label>
                      <button
                        aria-label={`Remove ${threshold.currency || "new"} threshold`}
                        className="row-action"
                        onClick={() => {
                          setThresholds((current) =>
                            current.filter((item) => item.id !== threshold.id),
                          );
                          setSaveState("idle");
                        }}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  className="button button--secondary"
                  disabled={thresholds.length >= 50}
                  onClick={() =>
                    setThresholds((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        currency: "",
                        amountMinor: "",
                      },
                    ])
                  }
                  type="button"
                >
                  <Plus aria-hidden="true" size={14} />
                  Add threshold
                </button>
              </fieldset>

              <label>
                Sensitive resolution types
                <textarea
                  aria-describedby="sensitive-types-help"
                  maxLength={5049}
                  onChange={(event) => {
                    setSensitiveTypes(event.target.value);
                    setSaveState("idle");
                  }}
                  rows={3}
                  value={sensitiveTypes}
                />
                <small id="sensitive-types-help">
                  Comma- or line-separated lowercase identifiers, such as write_off,
                  manual_override, and document_external_payment.
                </small>
              </label>

              <label>
                Reason · required and audit-visible
                <textarea
                  maxLength={2000}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setSaveState("idle");
                  }}
                  placeholder="Why is this policy change required?"
                  rows={3}
                  value={reason}
                />
              </label>

              <label className="policy-confirmation">
                <input
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  I confirm this changes the independent approval requirement for future proposals.
                </span>
              </label>

              {!parsedPolicy.ok ? (
                <div className="form-validation" role="alert">
                  <AlertTriangle aria-hidden="true" size={16} />
                  {parsedPolicy.message}
                </div>
              ) : null}

              <div className="policy-actions">
                <p aria-live="polite" className={`action-status action-status--${saveState}`}>
                  {saveState === "saving" ? "Recording policy change…" : saveMessage}
                </p>
                <button
                  className="button button--primary"
                  disabled={!canSave}
                  onClick={() => void savePolicy()}
                  type="button"
                >
                  {saveState === "saving" ? (
                    <LoaderCircle aria-hidden="true" className="spin" size={14} />
                  ) : saveState === "saved" ? (
                    <BadgeCheck aria-hidden="true" size={14} />
                  ) : (
                    <Save aria-hidden="true" size={14} />
                  )}
                  Save review policy
                </button>
              </div>
            </div>
          </>
        ) : null}
      </section>
    </>
  );
}

type ParsedPolicy =
  | {
      readonly ok: true;
      readonly thresholds: Readonly<Record<string, string>>;
      readonly sensitiveTypes: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

function parsePolicyDraft(
  thresholds: readonly ThresholdDraft[],
  sensitiveTypesValue: string,
): ParsedPolicy {
  const parsedThresholds: Record<string, string> = {};
  for (const threshold of thresholds) {
    const currency = threshold.currency.trim().toLocaleUpperCase("en-US");
    const amountMinor = threshold.amountMinor.trim();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      return { ok: false, message: "Every threshold requires a three-letter currency code." };
    }
    if (!/^(0|[1-9][0-9]{0,30})$/u.test(amountMinor)) {
      return {
        ok: false,
        message: "Every threshold must be a non-negative integer in minor units.",
      };
    }
    if (currency in parsedThresholds) {
      return { ok: false, message: `Currency ${currency} appears more than once.` };
    }
    parsedThresholds[currency] = amountMinor;
  }

  const sensitiveTypes = sensitiveTypesValue
    .split(/[,\n]/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (sensitiveTypes.length > 50) {
    return { ok: false, message: "At most 50 sensitive resolution types are allowed." };
  }
  if (sensitiveTypes.some((value) => !/^[a-z0-9_]{1,100}$/u.test(value))) {
    return {
      ok: false,
      message: "Sensitive resolution types must use lowercase letters, numbers, and underscores.",
    };
  }
  if (new Set(sensitiveTypes).size !== sensitiveTypes.length) {
    return { ok: false, message: "Sensitive resolution types cannot be duplicated." };
  }
  return {
    ok: true,
    thresholds: Object.fromEntries(
      Object.entries(parsedThresholds).sort(([left], [right]) => left.localeCompare(right, "en")),
    ),
    sensitiveTypes: [...sensitiveTypes].sort((left, right) => left.localeCompare(right, "en")),
  };
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
