"use client";

import {
  AlertTriangle,
  Cable,
  FileClock,
  History,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";

import { ConnectorCredentialControl } from "./connector-credential-control";
import { ProviderAuthorizationControl } from "./provider-authorization-control";

const connectionObjectTypeSchema = z.enum([
  "order",
  "refund_transaction",
  "payment_intent",
  "refund",
  "balance_transaction",
  "csv_row",
]);
const expectedObjectTypesByProvider = {
  shopify: ["order", "refund_transaction"],
  stripe: ["payment_intent", "refund", "balance_transaction"],
  accounting_csv: ["csv_row"],
} as const;

const connectionObjectWatermarkSchema = z.discriminatedUnion("observationState", [
  z
    .object({
      objectType: connectionObjectTypeSchema,
      observationState: z.literal("never_observed"),
    })
    .strict(),
  z
    .object({
      objectType: connectionObjectTypeSchema,
      observationState: z.literal("classification_unavailable"),
    })
    .strict(),
  z
    .object({
      objectType: connectionObjectTypeSchema,
      observationState: z.literal("observed"),
      latestSourceAt: z.iso.datetime({ offset: true }),
      latestReceivedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);

const connectionHealthItemSchema = z
  .object({
    id: z.uuid(),
    provider: z.enum(["shopify", "stripe", "accounting_csv"]),
    externalAccountId: z.string().min(1),
    status: z.enum([
      "healthy",
      "backfilling",
      "degraded",
      "stale",
      "disconnected",
      "action_required",
    ]),
    connectorVersion: z.string().min(1),
    syncEnabled: z.boolean(),
    apiVersion: z.string().min(1).optional(),
    lastSuccessfulSyncAt: z.iso.datetime({ offset: true }).optional(),
    lastVerifiedWebhookAt: z.iso.datetime({ offset: true }).optional(),
    retryCount: z.number().int().min(0),
    deadLetterCount: z.number().int().min(0),
    errorCode: z.string().min(1).optional(),
    objectWatermarks: z.array(connectionObjectWatermarkSchema).min(1).max(3),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((item, context) => {
    const expected = expectedObjectTypesByProvider[item.provider];
    if (
      item.objectWatermarks.length !== expected.length ||
      item.objectWatermarks.some((watermark, index) => watermark.objectType !== expected[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "connection source-watermark families do not match the provider contract",
        path: ["objectWatermarks"],
      });
    }
  });

const connectionHealthResponseSchema = z.object({
  data: z.array(connectionHealthItemSchema),
});

export type ConnectionHealthItem = z.infer<typeof connectionHealthItemSchema>;

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly ConnectionHealthItem[] };

interface CsvImportItem {
  readonly id: string;
  readonly connectionId: string;
  readonly status:
    "previewed" | "validation_failed" | "queued" | "succeeded" | "failed" | "rolled_back";
  readonly filename: string;
  readonly rowCount: number;
  readonly invalidRowCount: number;
  readonly uploadedAt: string;
  readonly completedAt?: string;
  readonly rolledBackAt?: string;
  readonly supersededRecordCount?: number;
}

type ImportState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly CsvImportItem[] };

interface ProviderSyncRunItem {
  readonly id: string;
  readonly connectionId: string;
  readonly provider: "shopify" | "stripe";
  readonly mode: "backfill" | "gap_repair";
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly status: "queued" | "running" | "partial" | "succeeded" | "failed";
  readonly pageCount: number;
  readonly itemCount: number;
  readonly duplicateCount: number;
  readonly maximumPages: number;
  readonly failedAttempts: number;
  readonly requesterType: "user" | "system";
  readonly lastErrorCode?: string;
  readonly createdAt: string;
}

type ProviderSyncState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly ProviderSyncRunItem[] };

export function ConnectorHealth() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [importState, setImportState] = useState<ImportState>({ kind: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void fetch("/api/recon?view=connections", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body: unknown = await response.json();
        const parsed = connectionHealthResponseSchema.safeParse(body);
        if (!response.ok || !parsed.success) {
          setState({
            kind: "error",
            message: responseMessage(body) ?? "Connector health could not be loaded.",
          });
          return;
        }
        setState({ kind: "ready", items: parsed.data.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "The connector health API is unavailable." });
      });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    setImportState({ kind: "loading" });
    void fetch("/api/recon?view=imports", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: readonly CsvImportItem[];
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setImportState({
            kind: "error",
            message: body.message ?? "Accounting imports could not be loaded.",
          });
          return;
        }
        setImportState({ kind: "ready", items: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setImportState({ kind: "error", message: "The accounting import API is unavailable." });
      });
    return () => controller.abort();
  }, [reload]);

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Read-only source boundary</p>
          <h1>Connector health</h1>
          <p>
            Persisted sync, webhook, and classified source-family watermarks with retry pressure and
            action-required state. Classification unavailable means at least one operational receipt
            lacks immutable family evidence. A healthy label or recent watermark is not a
            completeness or reconciliation guarantee.
          </p>
        </div>
        <button
          className="button button--secondary"
          disabled={state.kind === "loading"}
          onClick={() => setReload((value) => value + 1)}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={15} />
          Refresh health
        </button>
      </section>
      <section className="queue-panel">
        {state.kind === "loading" ? (
          <div aria-busy="true" className="workspace-loading">
            <LoaderCircle aria-hidden="true" className="spin" size={22} />
            Loading connector evidence…
          </div>
        ) : null}
        {state.kind === "error" ? (
          <div className="state-panel state-panel--error" role="alert">
            <AlertTriangle aria-hidden="true" size={22} />
            <div>
              <strong>Connector health unavailable</strong>
              <p>{state.message}</p>
            </div>
          </div>
        ) : null}
        {state.kind === "ready" && state.items.length === 0 ? (
          <div className="state-panel">
            <Cable aria-hidden="true" size={22} />
            <div>
              <strong>No connectors configured</strong>
              <p>No source freshness claim can be made until an administrator configures one.</p>
            </div>
          </div>
        ) : null}
        {state.kind === "ready" && state.items.length > 0 ? (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">
                Tenant-authorized connector health and freshness
              </caption>
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Account</th>
                  <th scope="col">State</th>
                  <th scope="col">Source families</th>
                  <th scope="col">Last sync</th>
                  <th scope="col">Last webhook</th>
                  <th scope="col">Retry / DLQ</th>
                  <th scope="col">Version</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{humanize(item.provider)}</strong>
                    </td>
                    <td>
                      <code>{item.externalAccountId}</code>
                    </td>
                    <td>
                      <span className="status-text">
                        <span aria-hidden="true">•</span>
                        {humanize(item.status)}
                      </span>
                      {item.errorCode ? <small>{item.errorCode}</small> : null}
                    </td>
                    <td>
                      <ul className="source-watermarks">
                        {item.objectWatermarks.map((watermark) => (
                          <li key={watermark.objectType}>
                            <strong>{sourceObjectLabel(watermark.objectType)}</strong>
                            {watermark.observationState === "observed" ? (
                              <small>
                                Source {formatTimestamp(watermark.latestSourceAt)}
                                <br />
                                Received {formatTimestamp(watermark.latestReceivedAt)}
                              </small>
                            ) : watermark.observationState === "classification_unavailable" ? (
                              <small>Classification unavailable</small>
                            ) : (
                              <small>Never observed</small>
                            )}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>{formatTimestamp(item.lastSuccessfulSyncAt)}</td>
                    <td>{formatTimestamp(item.lastVerifiedWebhookAt)}</td>
                    <td>
                      {item.retryCount}/{item.deadLetterCount}
                    </td>
                    <td>
                      <code>
                        {item.connectorVersion}
                        {item.apiVersion ? ` · ${item.apiVersion}` : ""}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <ProviderAuthorizationControl
        connections={
          state.kind === "ready"
            ? state.items.filter(
                (item) => item.provider === "shopify" || item.provider === "stripe",
              )
            : []
        }
      />
      <ConnectorCredentialControl
        connections={
          state.kind === "ready"
            ? state.items.filter(
                (item) => item.provider === "shopify" || item.provider === "stripe",
              )
            : []
        }
        onComplete={() => setReload((value) => value + 1)}
      />
      <ProviderSyncPanel connections={state.kind === "ready" ? state.items : []} reload={reload} />
      <section className="queue-panel" aria-labelledby="accounting-imports-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Immutable accounting evidence</p>
            <h2 id="accounting-imports-heading">Recent CSV imports</h2>
            <p>
              Rollback excludes an import from future reconciliation snapshots. Uploaded files,
              canonical records, provenance, and audit history remain retained.
            </p>
          </div>
        </div>
        {importState.kind === "loading" ? (
          <div aria-busy="true" className="workspace-loading">
            <LoaderCircle aria-hidden="true" className="spin" size={22} />
            Loading import history…
          </div>
        ) : null}
        {importState.kind === "error" ? (
          <div className="state-panel state-panel--error" role="alert">
            <AlertTriangle aria-hidden="true" size={22} />
            <div>
              <strong>Import history unavailable</strong>
              <p>{importState.message}</p>
            </div>
          </div>
        ) : null}
        {importState.kind === "ready" && importState.items.length === 0 ? (
          <div className="state-panel">
            <FileClock aria-hidden="true" size={22} />
            <div>
              <strong>No CSV imports recorded</strong>
              <p>Accounting CSV upload and preview are available through the tenant import API.</p>
            </div>
          </div>
        ) : null}
        {importState.kind === "ready" && importState.items.length > 0 ? (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">
                Tenant-authorized accounting CSV import history and rollback controls
              </caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">State</th>
                  <th scope="col">Rows</th>
                  <th scope="col">Uploaded</th>
                  <th scope="col">Rollback</th>
                </tr>
              </thead>
              <tbody>
                {importState.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.filename}</strong>
                      <small>
                        <code>{item.id}</code>
                      </small>
                    </td>
                    <td>
                      <span className="status-text">
                        <span aria-hidden="true">•</span>
                        {humanize(item.status)}
                      </span>
                      {item.status === "rolled_back" ? (
                        <small>
                          {item.supersededRecordCount ?? 0} canonical records superseded
                        </small>
                      ) : null}
                    </td>
                    <td>
                      {item.rowCount}
                      {item.invalidRowCount > 0 ? ` · ${String(item.invalidRowCount)} invalid` : ""}
                    </td>
                    <td>{formatTimestamp(item.uploadedAt)}</td>
                    <td>
                      {item.status === "succeeded" ? (
                        <RollbackImportControl
                          item={item}
                          onComplete={() => setReload((value) => value + 1)}
                        />
                      ) : (
                        <span className="muted-copy">
                          {item.status === "rolled_back" ? "Completed" : "Unavailable"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}

function responseMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message: unknown = (value as Record<string, unknown>)["message"];
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

function sourceObjectLabel(
  value: ConnectionHealthItem["objectWatermarks"][number]["objectType"],
): string {
  const labels = {
    order: "Order",
    refund_transaction: "Refund transaction",
    payment_intent: "Payment intent",
    refund: "Refund",
    balance_transaction: "Balance transaction",
    csv_row: "CSV row",
  } as const;
  return labels[value];
}

function ProviderSyncPanel({
  connections,
  reload,
}: {
  readonly connections: readonly ConnectionHealthItem[];
  readonly reload: number;
}) {
  const [state, setState] = useState<ProviderSyncState>({ kind: "loading" });
  const [historyReload, setHistoryReload] = useState(0);
  const syncEnabledConnections = connections.filter(
    (connection) =>
      (connection.provider === "shopify" || connection.provider === "stripe") &&
      connection.syncEnabled,
  );

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void fetch("/api/recon?view=provider_sync_runs", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: readonly ProviderSyncRunItem[];
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setState({
            kind: "error",
            message: body.message ?? "Provider sync history could not be loaded.",
          });
          return;
        }
        setState({ kind: "ready", items: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "The provider sync API is unavailable." });
      });
    return () => controller.abort();
  }, [historyReload, reload]);

  return (
    <section className="queue-panel" aria-labelledby="provider-sync-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Bounded recovery capture</p>
          <h2 id="provider-sync-heading">Provider recovery sync</h2>
          <p>
            Read-only Stripe event or Shopify order snapshot capture for an explicit window of at
            most 30 days. Each page and record is durably staged before reconciliation.
          </p>
        </div>
        <span className="source-boundary">
          <ShieldCheck aria-hidden="true" size={14} />
          No provider writes
        </span>
      </div>
      {syncEnabledConnections.length > 0 ? (
        <ProviderSyncControl
          connections={syncEnabledConnections}
          onComplete={() => setHistoryReload((value) => value + 1)}
        />
      ) : (
        <div className="state-panel">
          <History aria-hidden="true" size={22} />
          <div>
            <strong>No read-authorized provider connection</strong>
            <p>
              Configure a separate provider read API credential reference before requesting bounded
              backfill or gap repair. Webhook signing secrets are never reused.
            </p>
          </div>
        </div>
      )}
      {state.kind === "loading" ? (
        <div aria-busy="true" className="workspace-loading">
          <LoaderCircle aria-hidden="true" className="spin" size={22} />
          Loading provider sync history…
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div className="state-panel state-panel--error" role="alert">
          <AlertTriangle aria-hidden="true" size={22} />
          <div>
            <strong>Provider sync history unavailable</strong>
            <p>{state.message}</p>
          </div>
        </div>
      ) : null}
      {state.kind === "ready" && state.items.length === 0 ? (
        <div className="state-panel">
          <History aria-hidden="true" size={22} />
          <div>
            <strong>No provider sync runs recorded</strong>
            <p>Verified webhooks remain the live path; use sync only for bounded recovery.</p>
          </div>
        </div>
      ) : null}
      {state.kind === "ready" && state.items.length > 0 ? (
        <div className="table-scroll" tabIndex={0}>
          <table>
            <caption className="visually-hidden">
              Tenant-authorized bounded provider recovery history
            </caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Window</th>
                <th scope="col">Mode</th>
                <th scope="col">State</th>
                <th scope="col">Progress</th>
                <th scope="col">Requested</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((run) => (
                <tr key={run.id}>
                  <td>{humanize(run.provider)}</td>
                  <td>
                    <strong>{formatTimestamp(run.windowStart)}</strong>
                    <small>to {formatTimestamp(run.windowEnd)}</small>
                  </td>
                  <td>{humanize(run.mode)}</td>
                  <td>
                    <span className="status-text">
                      <span aria-hidden="true">•</span>
                      {humanize(run.status)}
                    </span>
                    {run.lastErrorCode ? <small>{run.lastErrorCode}</small> : null}
                  </td>
                  <td>
                    {run.pageCount}/{run.maximumPages} pages
                    <small>
                      {run.itemCount} records · {run.duplicateCount} duplicates
                    </small>
                  </td>
                  <td>
                    {formatTimestamp(run.createdAt)}
                    <small>
                      {run.requesterType === "system" ? "Automatic repair" : "Operator"}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function ProviderSyncControl({
  connections,
  onComplete,
}: {
  readonly connections: readonly ConnectionHealthItem[];
  readonly onComplete: () => void;
}) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [mode, setMode] = useState<"backfill" | "gap_repair">("gap_repair");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [maximumPages, setMaximumPages] = useState("5");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [failed, setFailed] = useState(false);
  const selectedConnection = connections.find((connection) => connection.id === connectionId);

  useEffect(() => {
    const end = new Date();
    end.setSeconds(0, 0);
    setWindowEnd(formatLocalDateTime(end));
    setWindowStart(formatLocalDateTime(new Date(end.getTime() - 24 * 60 * 60 * 1000)));
  }, []);

  async function startSync() {
    const start = new Date(windowStart);
    const end = new Date(windowEnd);
    const pageLimit = Number(maximumPages);
    if (
      !connectionId ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start ||
      end.getTime() - start.getTime() > 30 * 24 * 60 * 60 * 1000 ||
      !Number.isInteger(pageLimit) ||
      pageLimit < 1 ||
      pageLimit > 100 ||
      reason.trim().length < 3 ||
      !confirmed
    ) {
      setFailed(true);
      setMessage("Complete the bounded window, reason, page ceiling, and confirmation.");
      return;
    }
    setPending(true);
    setFailed(false);
    setMessage(undefined);
    try {
      const response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "start_provider_sync",
          connectionId,
          mode,
          windowStart: start.toISOString(),
          windowEnd: end.toISOString(),
          maximumPages: pageLimit,
          confirmed: true,
          reason,
        }),
      });
      const body = (await response.json()) as {
        readonly data?: { readonly provider: "shopify" | "stripe" };
        readonly message?: string;
      };
      if (!response.ok || !body.data) {
        setFailed(true);
        setMessage(body.message ?? "The provider sync could not be queued.");
        return;
      }
      setMessage(
        `Bounded ${humanize(body.data.provider)} recovery sync queued with durable tenant authority.`,
      );
      setReason("");
      setConfirmed(false);
      onComplete();
    } catch {
      setFailed(true);
      setMessage("The provider sync API is unavailable.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="run-start-panel provider-sync-control">
      <div className="run-start-panel__heading">
        <div>
          <h2>Request a recovery window</h2>
          <p>Maximum 100 pages and 10,000 provider records per immutable run.</p>
        </div>
      </div>
      <div className="run-policy-grid">
        <label>
          <span>Provider connection</span>
          <select
            disabled={pending}
            onChange={(event) => setConnectionId(event.target.value)}
            value={connectionId}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {humanize(connection.provider)} · {connection.externalAccountId}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Recovery mode</span>
          <select
            disabled={pending}
            onChange={(event) => setMode(event.target.value as "backfill" | "gap_repair")}
            value={mode}
          >
            <option value="gap_repair">Gap repair</option>
            <option value="backfill">Backfill</option>
          </select>
        </label>
        <label>
          <span>Window start</span>
          <input
            disabled={pending}
            onChange={(event) => setWindowStart(event.target.value)}
            type="datetime-local"
            value={windowStart}
          />
        </label>
        <label>
          <span>Window end</span>
          <input
            disabled={pending}
            onChange={(event) => setWindowEnd(event.target.value)}
            type="datetime-local"
            value={windowEnd}
          />
        </label>
        <label>
          <span>Maximum pages</span>
          <input
            disabled={pending}
            max={100}
            min={1}
            onChange={(event) => setMaximumPages(event.target.value)}
            type="number"
            value={maximumPages}
          />
        </label>
        <label className="run-policy-grid__reason">
          <span>Reason · required and audit-visible</span>
          <textarea
            disabled={pending}
            maxLength={2000}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this bounded recovery capture required?"
            rows={3}
            value={reason}
          />
        </label>
        <label className="confirmation-check run-policy-grid__reason">
          <input
            checked={confirmed}
            disabled={pending}
            onChange={(event) => setConfirmed(event.target.checked)}
            type="checkbox"
          />
          <span>
            I confirm this read-only request is limited to the selected provider account, time
            window, supported record families, and page ceiling.
          </span>
        </label>
      </div>
      <div className="run-start-panel__actions">
        <p>
          {selectedConnection?.provider === "stripe"
            ? "Stripe event listing is limited to the provider's 30-day event history."
            : "Shopify capture is limited to orders visible to the authorized app and this 30-day run window."}
        </p>
        <button
          className="button button--primary"
          disabled={pending || !confirmed || reason.trim().length < 3}
          onClick={() => void startSync()}
          type="button"
        >
          {pending ? (
            <LoaderCircle aria-hidden="true" className="spin" size={14} />
          ) : (
            <Play aria-hidden="true" size={14} />
          )}
          Queue bounded sync
        </button>
      </div>
      {message ? (
        <p
          aria-live="polite"
          className={`action-status action-status--${failed ? "failed" : "saved"}`}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

function RollbackImportControl({
  item,
  onComplete,
}: {
  readonly item: CsvImportItem;
  readonly onComplete: () => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();

  async function rollback() {
    if (confirmation !== item.id || reason.trim().length < 3) {
      setMessage("Enter a reason and the exact import ID.");
      return;
    }
    setPending(true);
    setMessage(undefined);
    try {
      const response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "rollback_import",
          importId: item.id,
          confirmImportId: confirmation,
          reason,
        }),
      });
      const body = (await response.json()) as {
        readonly data?: {
          readonly status: "rolled_back";
          readonly supersededRecordCount: number;
        };
        readonly message?: string;
      };
      if (!response.ok || body.data?.status !== "rolled_back") {
        setMessage(body.message ?? "Import rollback could not be completed.");
        return;
      }
      setMessage(
        `${String(body.data.supersededRecordCount)} canonical records were superseded for future runs.`,
      );
      onComplete();
    } catch {
      setMessage("The import rollback API is unavailable.");
    } finally {
      setPending(false);
    }
  }

  return (
    <details>
      <summary className="button button--secondary">
        <RotateCcw aria-hidden="true" size={14} />
        Roll back
      </summary>
      <div className="inline-form">
        <label>
          Reason
          <input
            disabled={pending}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why should this import be excluded?"
            value={reason}
          />
        </label>
        <label>
          Confirm import ID
          <input
            autoComplete="off"
            disabled={pending}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={item.id}
            value={confirmation}
          />
        </label>
        <button
          className="button button--danger"
          disabled={pending || confirmation !== item.id || reason.trim().length < 3}
          onClick={() => void rollback()}
          type="button"
        >
          {pending ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : null}
          Confirm rollback
        </button>
        {message ? (
          <p aria-live="polite" className="form-message">
            {message}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function humanize(value: string): string {
  const text = value.replaceAll("_", " ").toLocaleLowerCase("en-US");
  return text.charAt(0).toLocaleUpperCase("en-US") + text.slice(1);
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Never observed";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatLocalDateTime(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
