"use client";

import {
  AlertTriangle,
  Clock3,
  Download,
  Inbox,
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";

interface DeletionProgress {
  readonly total: number;
  readonly pending: number;
  readonly processing: number;
  readonly retry: number;
  readonly deleted: number;
  readonly alreadyMissing: number;
  readonly deadLettered: number;
}

interface PrivacyRequestItem {
  readonly id: string;
  readonly connectionId: string;
  readonly provider: "shopify";
  readonly topic: "customers/data_request" | "customers/redact" | "shop/redact";
  readonly apiVersion: string;
  readonly externalAccountId: string;
  readonly status: "action_required";
  readonly objectIdentifierCount: number;
  readonly receivedAt: string;
  readonly dueAt: string;
  readonly deadlineAlert?: {
    readonly stage: "due_7_days" | "due_24_hours" | "overdue";
    readonly observedAt: string;
  };
  readonly deletionProgress: DeletionProgress;
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly items: readonly PrivacyRequestItem[];
      readonly nextCursor?: string;
    };

type PackageState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving"; readonly requestId: string }
  | { readonly kind: "success"; readonly requestId: string; readonly message: string }
  | { readonly kind: "error"; readonly requestId: string; readonly message: string };

export function PrivacyRequestOperations() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [pageState, setPageState] = useState<"idle" | "loading" | "error">("idle");
  const [activePackageRequestId, setActivePackageRequestId] = useState<string>();
  const [packageReason, setPackageReason] = useState("");
  const [packageConfirmed, setPackageConfirmed] = useState(false);
  const [packageState, setPackageState] = useState<PackageState>({ kind: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/recon?view=privacy_requests", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: readonly PrivacyRequestItem[];
          readonly meta?: { readonly nextCursor?: string };
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setState({
            kind: "error",
            message: body.message ?? "Privacy requests could not be loaded.",
          });
          return;
        }
        setState({
          kind: "ready",
          items: body.data,
          ...(body.meta?.nextCursor ? { nextCursor: body.meta.nextCursor } : {}),
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "The privacy-request API is unavailable." });
      });
    return () => controller.abort();
  }, []);

  async function loadMore() {
    if (state.kind !== "ready" || !state.nextCursor || pageState === "loading") return;
    setPageState("loading");
    try {
      const response = await fetch(
        `/api/recon?view=privacy_requests&cursor=${encodeURIComponent(state.nextCursor)}`,
        { cache: "no-store" },
      );
      const body = (await response.json()) as {
        readonly data?: readonly PrivacyRequestItem[];
        readonly meta?: { readonly nextCursor?: string };
      };
      if (!response.ok || !body.data) {
        setPageState("error");
        return;
      }
      const pageItems = body.data;
      setState((current) => {
        if (current.kind !== "ready") return current;
        const byId = new Map(current.items.map((item) => [item.id, item]));
        for (const item of pageItems) byId.set(item.id, item);
        return {
          kind: "ready",
          items: [...byId.values()],
          ...(body.meta?.nextCursor ? { nextCursor: body.meta.nextCursor } : {}),
        };
      });
      setPageState("idle");
    } catch {
      setPageState("error");
    }
  }

  function openPackageForm(requestId: string) {
    setActivePackageRequestId(requestId);
    setPackageReason("");
    setPackageConfirmed(false);
    setPackageState({ kind: "idle" });
  }

  async function preparePackage(requestId: string) {
    if (packageState.kind === "saving" || !packageConfirmed || packageReason.trim().length < 3) {
      return;
    }
    setPackageState({ kind: "saving", requestId });
    try {
      const response = await fetch("/api/recon/exports/privacy-data-package", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          confirmed: true,
          reason: packageReason.trim(),
        }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { readonly message?: string };
        setPackageState({
          kind: "error",
          requestId,
          message: body.message ?? "The evidence package could not be prepared.",
        });
        return;
      }
      const blob = await response.blob();
      if (blob.size === 0) throw new Error("privacy evidence package is empty");
      const packageId = response.headers.get("x-reconai-privacy-package-id");
      const receiptToken = response.headers.get("x-reconai-privacy-package-receipt-token");
      const receiptExpiresAt = response.headers.get("x-reconai-privacy-package-receipt-expires-at");
      if (
        !packageId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          packageId,
        ) ||
        !receiptToken ||
        !/^[A-Za-z0-9_-]{43}$/u.test(receiptToken) ||
        !receiptExpiresAt ||
        !Number.isFinite(Date.parse(receiptExpiresAt))
      ) {
        throw new Error("privacy evidence package receipt authority is invalid");
      }
      const receiptResponse = await fetch("/api/recon/exports/privacy-data-package", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "acknowledge_browser_receipt",
          requestId,
          packageId,
          receiptToken,
        }),
      });
      const receiptBody = (await receiptResponse.json()) as {
        readonly data?: {
          readonly packageId?: string;
          readonly status?: "acknowledged" | "already_acknowledged";
        };
      };
      if (
        !receiptResponse.ok ||
        receiptBody.data?.packageId !== packageId ||
        (receiptBody.data.status !== "acknowledged" &&
          receiptBody.data.status !== "already_acknowledged")
      ) {
        setPackageState({
          kind: "error",
          requestId,
          message:
            "The evidence package was not downloaded because browser receipt could not be recorded.",
        });
        return;
      }
      const url = URL.createObjectURL(blob);
      const download = document.createElement("a");
      download.href = url;
      download.download = "reconai-shopify-customer-data-evidence.json";
      download.click();
      URL.revokeObjectURL(url);
      setPackageState({
        kind: "success",
        requestId,
        message:
          "Evidence package browser receipt audit-recorded. Review it before controlled merchant delivery; this does not prove fulfillment.",
      });
    } catch {
      setPackageState({
        kind: "error",
        requestId,
        message: "The privacy evidence package is unavailable.",
      });
    }
  }

  return (
    <section className="queue-panel" aria-labelledby="privacy-request-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Authenticated provider requests</p>
          <h2 id="privacy-request-heading">Shopify privacy requests</h2>
          <p>
            Owner and administrator view of action-required requests, deadlines, and aggregate raw
            object deletion progress. Identifiers stay hidden until an explicitly confirmed,
            audit-recorded evidence-package download.
          </p>
        </div>
        <span className="source-boundary">
          <ShieldCheck aria-hidden="true" size={14} />
          Minimized metadata
        </span>
      </div>
      <div className="retention-warning" role="note">
        <ShieldAlert aria-hidden="true" size={20} />
        <div>
          <strong>Raw object erasure only</strong>
          <p>
            A completed raw deletion count does not complete the privacy request or erase canonical,
            provenance, audit, tombstone, backup, or merchant-controlled data.
          </p>
        </div>
      </div>
      {state.kind === "loading" ? (
        <div aria-busy="true" className="workspace-loading">
          <LoaderCircle aria-hidden="true" className="spin" size={22} />
          Loading privacy requests…
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div className="state-panel state-panel--error" role="alert">
          <AlertTriangle aria-hidden="true" size={22} />
          <div>
            <strong>Privacy requests unavailable</strong>
            <p>{state.message}</p>
          </div>
        </div>
      ) : null}
      {state.kind === "ready" && state.items.length === 0 ? (
        <div className="state-panel">
          <Inbox aria-hidden="true" size={22} />
          <div>
            <strong>No authenticated Shopify privacy requests</strong>
            <p>There are no action-required requests recorded for this organization.</p>
          </div>
        </div>
      ) : null}
      {state.kind === "ready" && state.items.length > 0 ? (
        <>
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">
                Tenant-authorized Shopify privacy request operations
              </caption>
              <thead>
                <tr>
                  <th scope="col">Shop</th>
                  <th scope="col">Request</th>
                  <th scope="col">Deadline</th>
                  <th scope="col">Raw deletion</th>
                  <th scope="col">Operator action</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <strong>{request.externalAccountId}</strong>
                      <small>Shopify API {request.apiVersion}</small>
                    </td>
                    <td>
                      <strong>{topicLabel(request.topic)}</strong>
                      <small>
                        Action required · {request.objectIdentifierCount} object identifier
                        {request.objectIdentifierCount === 1 ? "" : "s"}
                      </small>
                    </td>
                    <td>
                      <span className="status-text">
                        <Clock3 aria-hidden="true" size={12} />
                        <time dateTime={request.dueAt}>{formatTimestamp(request.dueAt)}</time>
                      </span>
                      {request.deadlineAlert ? (
                        <small
                          className={`privacy-deadline-alert privacy-deadline-alert--${request.deadlineAlert.stage}`}
                        >
                          <AlertTriangle aria-hidden="true" size={11} />
                          {deadlineAlertLabel(request.deadlineAlert.stage)} ·{" "}
                          <time dateTime={request.deadlineAlert.observedAt}>
                            {formatTimestamp(request.deadlineAlert.observedAt)}
                          </time>
                        </small>
                      ) : null}
                      <small>Received {formatTimestamp(request.receivedAt)}</small>
                    </td>
                    <td>{deletionStatus(request)}</td>
                    <td>
                      {request.topic === "customers/data_request" ? (
                        activePackageRequestId === request.id ? (
                          <form
                            className="privacy-package-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void preparePackage(request.id);
                            }}
                          >
                            <label htmlFor={`privacy-package-reason-${request.id}`}>
                              Preparation reason
                            </label>
                            <textarea
                              id={`privacy-package-reason-${request.id}`}
                              maxLength={2000}
                              onChange={(event) => setPackageReason(event.target.value)}
                              placeholder="Why is this package being prepared?"
                              required
                              rows={3}
                              value={packageReason}
                            />
                            <label className="privacy-package-confirmation">
                              <input
                                checked={packageConfirmed}
                                onChange={(event) => setPackageConfirmed(event.target.checked)}
                                type="checkbox"
                              />
                              I understand this is a scoped evidence package, not proof of request
                              fulfillment or delivery.
                            </label>
                            <div className="privacy-package-actions">
                              <button
                                className="button button--primary"
                                disabled={
                                  !packageConfirmed ||
                                  packageReason.trim().length < 3 ||
                                  packageState.kind === "saving"
                                }
                                type="submit"
                              >
                                <Download aria-hidden="true" size={14} />
                                {packageState.kind === "saving"
                                  ? "Preparing…"
                                  : "Prepare and download"}
                              </button>
                              <button
                                className="button button--secondary"
                                disabled={packageState.kind === "saving"}
                                onClick={() => setActivePackageRequestId(undefined)}
                                type="button"
                              >
                                Cancel
                              </button>
                            </div>
                            {packageState.kind !== "idle" &&
                            packageState.kind !== "saving" &&
                            packageState.requestId === request.id ? (
                              <p
                                aria-live="polite"
                                className={
                                  packageState.kind === "error"
                                    ? "privacy-package-message privacy-package-message--error"
                                    : "privacy-package-message"
                                }
                                role={packageState.kind === "error" ? "alert" : "status"}
                              >
                                {packageState.message}
                              </p>
                            ) : null}
                          </form>
                        ) : (
                          <button
                            className="button button--secondary"
                            onClick={() => openPackageForm(request.id)}
                            type="button"
                          >
                            <Download aria-hidden="true" size={14} />
                            Prepare evidence package
                          </button>
                        )
                      ) : (
                        <small>Raw-erasure workflow tracked above.</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Shopify privacy request pages" className="queue-pagination">
            <p aria-live="polite">
              Showing {state.items.length.toLocaleString("en-US")} earliest request
              {state.items.length === 1 ? "" : "s"}
              {state.nextCursor ? " · more available" : ""}
              {pageState === "error" ? " · next page unavailable" : ""}
            </p>
            <div>
              <button
                className="button button--secondary"
                disabled={!state.nextCursor || pageState === "loading"}
                onClick={() => void loadMore()}
                type="button"
              >
                {pageState === "loading" ? "Loading…" : "Load more privacy requests"}
              </button>
            </div>
          </nav>
        </>
      ) : null}
    </section>
  );
}

function deletionStatus(request: PrivacyRequestItem) {
  if (request.topic === "customers/data_request") {
    return (
      <>
        <strong>Merchant data package required</strong>
        <small>No automatic deletion is scheduled for this request.</small>
      </>
    );
  }
  const progress = request.deletionProgress;
  const completed = progress.deleted + progress.alreadyMissing;
  return (
    <>
      <strong>
        {completed}/{progress.total} raw objects complete
      </strong>
      <small>
        {progress.pending} pending · {progress.processing} processing · {progress.retry} retry ·{" "}
        {progress.deadLettered} dead-lettered
      </small>
    </>
  );
}

function topicLabel(topic: PrivacyRequestItem["topic"]): string {
  switch (topic) {
    case "customers/data_request":
      return "Customer data request";
    case "customers/redact":
      return "Customer redaction";
    case "shop/redact":
      return "Shop redaction";
  }
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function deadlineAlertLabel(
  stage: NonNullable<PrivacyRequestItem["deadlineAlert"]>["stage"],
): string {
  switch (stage) {
    case "due_7_days":
      return "7-day escalation recorded";
    case "due_24_hours":
      return "24-hour escalation recorded";
    case "overdue":
      return "Overdue escalation recorded";
  }
}
