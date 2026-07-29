"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  Download,
  FileSearch,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode, type SyntheticEvent } from "react";

interface ExceptionItem {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly severity: string;
  readonly sources: readonly ("shopify" | "stripe" | "accounting_csv")[];
  readonly confidence: "high" | "low" | "unclassified";
  readonly assignee: "me" | "assigned" | "unassigned";
  readonly amountMinor?: string;
  readonly currency?: string;
  readonly createdAt: string;
}

interface ApiResponse {
  readonly data?: readonly ExceptionItem[];
  readonly meta?: {
    readonly filteredCount?: number;
    readonly nextCursor?: string;
    readonly canExport?: boolean;
    readonly summary?: QueueSummary;
  };
  readonly code?: string;
  readonly message?: string;
}

interface QueueSummary {
  readonly open: number;
  readonly high: number;
  readonly awaitingApproval: number;
  readonly decided: number;
}

interface QueueFilters {
  readonly search: string;
  readonly status: string;
  readonly severity: string;
  readonly source: string;
  readonly amountCurrency: string;
  readonly minimumAmountMinor: string;
  readonly maximumAmountMinor: string;
  readonly confidence: string;
  readonly assignee: string;
  readonly age: string;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly code: string; readonly message: string }
  | {
      readonly kind: "ready";
      readonly items: readonly ExceptionItem[];
      readonly filteredCount: number;
      readonly canExport: boolean;
      readonly summary: QueueSummary;
      readonly nextCursor?: string;
    };

type ExportState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "success"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

const emptySummary: QueueSummary = { open: 0, high: 0, awaitingApproval: 0, decided: 0 };
const initialFilters: QueueFilters = {
  search: "",
  status: "all",
  severity: "all",
  source: "all",
  amountCurrency: "",
  minimumAmountMinor: "",
  maximumAmountMinor: "",
  confidence: "all",
  assignee: "all",
  age: "all",
};
const exportFilename = "reconai-exception-queue.csv";

export function DashboardClient() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshToken, setRefreshToken] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [source, setSource] = useState("all");
  const [amountCurrency, setAmountCurrency] = useState("");
  const [minimumAmountMinor, setMinimumAmountMinor] = useState("");
  const [maximumAmountMinor, setMaximumAmountMinor] = useState("");
  const [confidence, setConfidence] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [age, setAge] = useState("all");
  const [filterError, setFilterError] = useState<string>();
  const [filters, setFilters] = useState<QueueFilters>(initialFilters);
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const [cursorHistory, setCursorHistory] = useState<readonly (string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const cursor = cursorHistory[pageIndex];
  const hasActiveFilters =
    filters.search.length > 0 ||
    filters.status !== "all" ||
    filters.severity !== "all" ||
    filters.source !== "all" ||
    filters.amountCurrency.length > 0 ||
    filters.minimumAmountMinor.length > 0 ||
    filters.maximumAmountMinor.length > 0 ||
    filters.confidence !== "all" ||
    filters.assignee !== "all" ||
    filters.age !== "all";

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    const query = new URLSearchParams({ view: "summary" });
    if (filters.status !== "all") query.set("status", filters.status);
    if (filters.severity !== "all") query.set("severity", filters.severity);
    if (filters.search) query.set("search", filters.search);
    if (filters.source !== "all") query.set("source", filters.source);
    if (filters.amountCurrency) query.set("amountCurrency", filters.amountCurrency);
    if (filters.minimumAmountMinor) {
      query.set("minimumAmountMinor", filters.minimumAmountMinor);
    }
    if (filters.maximumAmountMinor) {
      query.set("maximumAmountMinor", filters.maximumAmountMinor);
    }
    if (filters.confidence !== "all") query.set("confidence", filters.confidence);
    if (filters.assignee !== "all") query.set("assignee", filters.assignee);
    if (filters.age !== "all") query.set("age", filters.age);
    if (cursor) query.set("cursor", cursor);
    void fetch(`/api/recon?${query.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as ApiResponse;
        if (
          !response.ok ||
          !body.data ||
          typeof body.meta?.filteredCount !== "number" ||
          !body.meta.summary
        ) {
          setState({
            kind: "error",
            code: body.code ?? "REQUEST_FAILED",
            message: body.message ?? "The exception queue could not be loaded.",
          });
          return;
        }
        setState({
          kind: "ready",
          items: body.data,
          filteredCount: body.meta.filteredCount,
          canExport: body.meta.canExport === true,
          summary: body.meta.summary,
          ...(body.meta.nextCursor ? { nextCursor: body.meta.nextCursor } : {}),
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          kind: "error",
          code: "NETWORK_ERROR",
          message: "ReconAI could not reach the API. Check service readiness.",
        });
      });
    return () => controller.abort();
  }, [cursor, filters, refreshToken]);

  const metrics = state.kind === "ready" ? state.summary : emptySummary;

  function resetPagination() {
    setCursorHistory([undefined]);
    setPageIndex(0);
  }

  function applyFilters(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedCurrency = amountCurrency.trim().toUpperCase();
    const normalizedMinimum = minimumAmountMinor.trim();
    const normalizedMaximum = maximumAmountMinor.trim();
    if ((normalizedMinimum || normalizedMaximum) && !normalizedCurrency) {
      setFilterError("Choose a currency before applying an amount range.");
      return;
    }
    if (
      normalizedMinimum &&
      normalizedMaximum &&
      BigInt(normalizedMinimum) > BigInt(normalizedMaximum)
    ) {
      setFilterError("Minimum amount cannot exceed maximum amount.");
      return;
    }
    setFilterError(undefined);
    setExportState({ kind: "idle" });
    setFilters({
      search: search.trim(),
      status,
      severity,
      source,
      amountCurrency: normalizedCurrency,
      minimumAmountMinor: normalizedMinimum,
      maximumAmountMinor: normalizedMaximum,
      confidence,
      assignee,
      age,
    });
    resetPagination();
  }

  function clearFilters() {
    setExportState({ kind: "idle" });
    setSearch("");
    setStatus("all");
    setSeverity("all");
    setSource("all");
    setAmountCurrency("");
    setMinimumAmountMinor("");
    setMaximumAmountMinor("");
    setConfidence("all");
    setAssignee("all");
    setAge("all");
    setFilterError(undefined);
    setFilters(initialFilters);
    resetPagination();
  }

  async function exportQueue() {
    setExportState({ kind: "pending" });
    const body = {
      ...(filters.status !== "all" ? { status: filters.status } : {}),
      ...(filters.severity !== "all" ? { severity: filters.severity } : {}),
      ...(filters.search ? { search: filters.search } : {}),
      ...(filters.source !== "all" ? { source: filters.source } : {}),
      ...(filters.amountCurrency ? { amountCurrency: filters.amountCurrency } : {}),
      ...(filters.minimumAmountMinor ? { minimumAmountMinor: filters.minimumAmountMinor } : {}),
      ...(filters.maximumAmountMinor ? { maximumAmountMinor: filters.maximumAmountMinor } : {}),
      ...(filters.confidence !== "all" ? { confidence: filters.confidence } : {}),
      ...(filters.assignee !== "all" ? { assignee: filters.assignee } : {}),
      ...(filters.age !== "all" ? { age: filters.age } : {}),
    };
    try {
      const response = await fetch("/api/recon/exports/exceptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (!response.ok) {
        let message = "The exception export could not be prepared.";
        if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
          const error = (await response.json()) as { readonly message?: string };
          if (error.message) message = error.message;
        }
        setExportState({ kind: "error", message });
        return;
      }
      if (!response.headers.get("content-type")?.toLowerCase().includes("text/csv")) {
        throw new Error("The export response was not a CSV file.");
      }
      const payload = await response.blob();
      if (payload.size === 0) throw new Error("The export response was empty.");

      const url = URL.createObjectURL(payload);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exportFilename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      const rowCount = state.kind === "ready" ? state.filteredCount : 0;
      setExportState({
        kind: "success",
        message: `Downloaded ${rowCount.toLocaleString("en-US")} rows · ${payload.size.toLocaleString("en-US")} bytes`,
      });
    } catch (error) {
      setExportState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "The exception export could not be prepared.",
      });
    }
  }

  return (
    <>
      <section aria-labelledby="queue-heading" className="page-heading">
        <div>
          <p className="eyebrow">Reconciliation control desk</p>
          <h1 id="queue-heading">Exception queue</h1>
          <p>
            Deterministic discrepancies ordered by severity and age. Every decision stays inside
            ReconAI; connected sources remain read-only.
          </p>
        </div>
        <div className="page-heading__controls">
          <div className="page-heading__actions">
            <button
              className="button button--secondary"
              disabled={state.kind === "loading" || exportState.kind === "pending"}
              onClick={() => {
                setExportState({ kind: "idle" });
                resetPagination();
                setRefreshToken((value) => value + 1);
              }}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={15} />
              Refresh evidence
            </button>
            <button
              className="button button--primary"
              disabled={
                state.kind !== "ready" || !state.canExport || exportState.kind === "pending"
              }
              onClick={() => void exportQueue()}
              type="button"
            >
              <Download aria-hidden="true" size={15} />
              {exportState.kind === "pending" ? "Preparing CSV…" : "Export filtered CSV"}
            </button>
          </div>
          {state.kind === "ready" && !state.canExport ? (
            <span className="export-status">Export requires the data-export permission.</span>
          ) : exportState.kind === "success" || exportState.kind === "error" ? (
            <span
              className={`export-status ${
                exportState.kind === "error" ? "export-status--error" : ""
              }`}
              role={exportState.kind === "error" ? "alert" : "status"}
            >
              {exportState.message}
            </span>
          ) : null}
        </div>
      </section>

      <section aria-label="Queue summary" className="metric-strip">
        <Metric label="Open exceptions" value={metrics.open} icon={<CircleDashed size={17} />} />
        <Metric label="High severity" value={metrics.high} icon={<AlertTriangle size={17} />} />
        <Metric
          label="Awaiting approval"
          value={metrics.awaitingApproval}
          icon={<FileSearch size={17} />}
        />
        <Metric label="Decided" value={metrics.decided} icon={<CheckCircle2 size={17} />} />
      </section>

      <section className="queue-panel">
        <div className="queue-toolbar">
          <div>
            <h2>Evidence requiring attention</h2>
            <p>Live data from the tenant-authorized API. No inferred savings or accuracy claims.</p>
          </div>
          <span className="source-boundary">Source access · Read only</span>
        </div>
        <form className="queue-filters" onSubmit={applyFilters}>
          <label>
            <span>Exact exception ID or type</span>
            <input
              maxLength={100}
              onChange={(event) => setSearch(event.target.value)}
              pattern="[A-Za-z0-9 _-]{1,100}"
              placeholder="payment_without_order"
              type="search"
              value={search}
            />
          </label>
          <label>
            <span>Status</span>
            <select onChange={(event) => setStatus(event.target.value)} value={status}>
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="assigned">Assigned</option>
              <option value="deferred">Deferred</option>
              <option value="proposed">Proposed</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="superseded">Superseded</option>
            </select>
          </label>
          <label>
            <span>Severity</span>
            <select onChange={(event) => setSeverity(event.target.value)} value={severity}>
              <option value="all">All severities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label>
            <span>Source</span>
            <select onChange={(event) => setSource(event.target.value)} value={source}>
              <option value="all">All sources</option>
              <option value="shopify">Shopify</option>
              <option value="stripe">Stripe</option>
              <option value="accounting_csv">Accounting CSV</option>
              <option value="unclassified">Unclassified source</option>
            </select>
          </label>
          <label>
            <span>Confidence</span>
            <select onChange={(event) => setConfidence(event.target.value)} value={confidence}>
              <option value="all">All confidence</option>
              <option value="high">High</option>
              <option value="low">Low</option>
              <option value="unclassified">Unclassified</option>
            </select>
          </label>
          <label>
            <span>Assignee</span>
            <select onChange={(event) => setAssignee(event.target.value)} value={assignee}>
              <option value="all">All assignment states</option>
              <option value="me">Assigned to me</option>
              <option value="assigned">Assigned to anyone</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
          <label>
            <span>Age · server UTC</span>
            <select onChange={(event) => setAge(event.target.value)} value={age}>
              <option value="all">All ages</option>
              <option value="under_24h">Under 24 hours</option>
              <option value="one_to_seven_days">1–7 days</option>
              <option value="seven_to_thirty_days">7–30 days</option>
              <option value="over_30_days">Over 30 days</option>
            </select>
          </label>
          <label>
            <span>Amount currency</span>
            <input
              aria-describedby="amount-filter-help"
              autoCapitalize="characters"
              maxLength={3}
              onChange={(event) => setAmountCurrency(event.target.value.toUpperCase())}
              pattern="[A-Z]{3}"
              placeholder="USD"
              required={Boolean(minimumAmountMinor || maximumAmountMinor)}
              spellCheck={false}
              value={amountCurrency}
            />
          </label>
          <label>
            <span>Minimum minor units</span>
            <input
              aria-describedby="amount-filter-help"
              inputMode="numeric"
              maxLength={32}
              onChange={(event) => setMinimumAmountMinor(event.target.value)}
              pattern="-?(0|[1-9][0-9]{0,30})"
              placeholder="0"
              value={minimumAmountMinor}
            />
          </label>
          <label>
            <span>Maximum minor units</span>
            <input
              aria-describedby="amount-filter-help"
              inputMode="numeric"
              maxLength={32}
              onChange={(event) => setMaximumAmountMinor(event.target.value)}
              pattern="-?(0|[1-9][0-9]{0,30})"
              placeholder="250000"
              value={maximumAmountMinor}
            />
          </label>
          <div className="queue-filters__actions">
            <button className="button button--primary" type="submit">
              Apply filters
            </button>
            <button className="button button--secondary" onClick={clearFilters} type="button">
              Clear
            </button>
          </div>
          <p className="queue-filters__help" id="amount-filter-help">
            Amount ranges use signed integer minor units and require an exact ISO currency; ReconAI
            never compares different currencies.
          </p>
          {filterError ? (
            <p className="queue-filters__error" role="alert">
              {filterError}
            </p>
          ) : null}
        </form>

        {state.kind === "loading" ? <QueueLoading /> : null}
        {state.kind === "error" ? (
          <div className="state-panel state-panel--error" role="alert">
            <AlertTriangle aria-hidden="true" size={22} />
            <div>
              <strong>{humanizeCode(state.code)}</strong>
              <p>{state.message}</p>
            </div>
          </div>
        ) : null}
        {state.kind === "ready" && state.items.length === 0 ? (
          <QueueEmpty filtered={hasActiveFilters} />
        ) : null}
        {state.kind === "ready" && state.items.length > 0 ? (
          <>
            <ExceptionTable items={state.items} />
            <nav aria-label="Exception queue pages" className="queue-pagination">
              <p aria-live="polite">
                Showing {(pageIndex * 50 + 1).toLocaleString("en-US")}–
                {Math.min(pageIndex * 50 + state.items.length, state.filteredCount).toLocaleString(
                  "en-US",
                )}{" "}
                of {state.filteredCount.toLocaleString("en-US")}
              </p>
              <div>
                <button
                  className="button button--secondary"
                  disabled={pageIndex === 0}
                  onClick={() => setPageIndex((value) => Math.max(0, value - 1))}
                  type="button"
                >
                  Previous page
                </button>
                <button
                  className="button button--secondary"
                  disabled={!state.nextCursor}
                  onClick={() => {
                    if (!state.nextCursor) return;
                    setCursorHistory((history) => [
                      ...history.slice(0, pageIndex + 1),
                      state.nextCursor,
                    ]);
                    setPageIndex((value) => value + 1);
                  }}
                  type="button"
                >
                  Next page
                </button>
              </div>
            </nav>
          </>
        ) : null}
      </section>
    </>
  );
}

function Metric({
  label,
  value,
  icon,
}: {
  readonly label: string;
  readonly value: number;
  readonly icon: ReactNode;
}) {
  return (
    <div className="metric">
      <span className="metric__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="metric__value">{value.toLocaleString("en-US")}</span>
      <span className="metric__label">{label}</span>
    </div>
  );
}

function ExceptionTable({ items }: { readonly items: readonly ExceptionItem[] }) {
  return (
    <div className="table-scroll" tabIndex={0}>
      <table>
        <caption className="visually-hidden">
          Reconciliation exceptions ordered by severity and creation time
        </caption>
        <thead>
          <tr>
            <th scope="col">Exception</th>
            <th scope="col">Status</th>
            <th scope="col">Severity</th>
            <th scope="col">Source</th>
            <th scope="col">Confidence</th>
            <th scope="col">Assignee</th>
            <th scope="col">Amount</th>
            <th scope="col">Observed</th>
            <th scope="col">
              <span className="visually-hidden">Open investigation</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <Link className="exception-link" href={`/dashboard/exceptions/${item.id}`}>
                  <span>{humanizeCode(item.type)}</span>
                  <code>{item.id.slice(0, 8)}</code>
                </Link>
              </td>
              <td>
                <StatusText value={item.status} />
              </td>
              <td>
                <span className={`severity severity--${item.severity}`}>
                  <span aria-hidden="true">●</span>
                  {humanizeCode(item.severity)}
                </span>
              </td>
              <td>
                {item.sources.length > 0
                  ? item.sources.map(humanizeCode).join(", ")
                  : "Unclassified"}
              </td>
              <td>{humanizeCode(item.confidence)}</td>
              <td>{humanizeCode(item.assignee)}</td>
              <td className="money">
                {item.amountMinor && item.currency
                  ? formatMinor(item.amountMinor, item.currency)
                  : "—"}
              </td>
              <td>{formatTimestamp(item.createdAt)}</td>
              <td>
                <Link
                  aria-label={`Open ${humanizeCode(item.type)}`}
                  className="row-action"
                  href={`/dashboard/exceptions/${item.id}`}
                >
                  <ArrowUpRight aria-hidden="true" size={16} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusText({ value }: { readonly value: string }) {
  const resolved = ["approved", "rejected", "superseded"].includes(value);
  return (
    <span className={`status-text ${resolved ? "status-text--resolved" : ""}`}>
      <span aria-hidden="true">{resolved ? "✓" : "•"}</span>
      {humanizeCode(value)}
    </span>
  );
}

function QueueLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="queue-loading">
      <div />
      <div />
      <div />
      <span>Loading tenant-scoped evidence…</span>
    </div>
  );
}

function QueueEmpty({ filtered }: { readonly filtered: boolean }) {
  return (
    <div className="state-panel">
      {filtered ? (
        <FileSearch aria-hidden="true" size={24} />
      ) : (
        <CheckCircle2 aria-hidden="true" size={24} />
      )}
      <div>
        <strong>
          {filtered ? "No exceptions match these filters" : "No exceptions in this queue"}
        </strong>
        <p>
          {filtered
            ? "Clear or change the filters. The underlying exception evidence is unchanged."
            : "This is an empty state, not a claim that connected systems are reconciled. Check connector freshness and the latest run before closing the period."}
        </p>
      </div>
    </div>
  );
}

function humanizeCode(value: string): string {
  const text = value.replaceAll("_", " ").toLocaleLowerCase("en-US");
  return text.charAt(0).toLocaleUpperCase("en-US") + text.slice(1);
}

function formatMinor(minor: string, currency: string): string {
  const value = BigInt(minor);
  const exponent = currencyExponents[currency];
  if (exponent === undefined) return `${currency} ${value.toString()} minor units`;
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(exponent);
  const whole = absolute / scale;
  const fraction =
    exponent === 0 ? "" : `.${(absolute % scale).toString().padStart(exponent, "0")}`;
  return `${negative ? "−" : ""}${currency} ${whole.toLocaleString("en-US")}${fraction}`;
}

const currencyExponents: Readonly<Record<string, number>> = Object.freeze({
  AUD: 2,
  BHD: 3,
  CAD: 2,
  CHF: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  NZD: 2,
  PHP: 2,
  SGD: 2,
  USD: 2,
});

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
