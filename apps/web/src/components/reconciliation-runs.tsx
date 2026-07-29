"use client";

import {
  AlertTriangle,
  Archive,
  FileClock,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type RunStatus = "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled";

interface RunSummary {
  readonly id: string;
  readonly stableRunKey: string;
  readonly status: RunStatus;
  readonly policyVersion: string;
  readonly ruleSetVersion: string;
  readonly engineVersion: string;
  readonly inputCount: number;
  readonly matchCount: number;
  readonly exceptionCount: number;
  readonly errorCount: number;
  readonly dispatchCount: number;
  readonly operationalStateApplied: boolean;
  readonly lastErrorCode?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
}

interface RunDetail extends RunSummary {
  readonly inputSnapshotHash: string;
  readonly policySnapshotHash: string;
  readonly policySnapshot: unknown;
  readonly initiatedBy: string;
  readonly inputRecords: readonly RunInputRecord[];
  readonly inputRecordsTruncated: boolean;
  readonly matches: readonly RunMatchArtifact[];
  readonly matchesTruncated: boolean;
  readonly exceptions: readonly RunExceptionArtifact[];
  readonly exceptionsTruncated: boolean;
}

interface RunInputRecord {
  readonly id: string;
  readonly version: number;
  readonly contentSha256: string;
  readonly ordinal: number;
}

interface RunMatchArtifact {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly recordReferences: readonly string[];
  readonly recordReferencesStatus: "available" | "unavailable";
  readonly evidence: DeterministicEvidenceView;
  readonly evidenceFidelity: "exact_at_observation" | "legacy_current_projection";
  readonly observedAt: string;
}

interface RunExceptionArtifact {
  readonly id: string;
  readonly type: string;
  readonly observedStatus: string;
  readonly currentStatus: string;
  readonly severity: string;
  readonly recordReferences: readonly string[];
  readonly recordReferencesStatus: "available" | "unavailable";
  readonly amountMinor?: string;
  readonly currency?: string;
  readonly evidence: DeterministicEvidenceView;
  readonly evidenceFidelity: "exact_at_observation" | "legacy_current_projection";
  readonly observedAt: string;
}

type DeterministicEvidenceView =
  | {
      readonly schemaVersion: "deterministic-evidence-view-v1";
      readonly status: "available";
      readonly ruleId: string;
      readonly ruleVersion: string;
      readonly ruleSetVersion: string;
      readonly sourceRecordCount: number;
      readonly evidenceTruncated: boolean;
      readonly comparisons: readonly {
        readonly source: Readonly<Record<string, string>>;
        readonly normalized: Readonly<Record<string, string>>;
      }[];
      readonly toleranceMinor?: string;
      readonly candidateSearch?: {
        readonly eligibleCount: number;
        readonly evaluatedCount: number;
        readonly emittedCount: number;
        readonly evaluationLimit: number;
        readonly complete: boolean;
      };
      readonly accountingCandidateSearch?: {
        readonly eligibleCountLowerBound: number;
        readonly evaluationLimit: number;
        readonly complete: false;
      };
      readonly result: "pass" | "fail" | "defer" | "ambiguous";
      readonly reasonCode: string;
      readonly evaluatedAt: string;
    }
  | {
      readonly schemaVersion: "deterministic-evidence-view-v1";
      readonly status: "unavailable";
      readonly reasonCode: "EVIDENCE_UNSUPPORTED_OR_MALFORMED";
    };

type RunArtifact = RunMatchArtifact | RunExceptionArtifact;
type RunArtifactType = "match" | "exception";
const artifactCursorPattern = /^[A-Za-z0-9_-]{1,1024}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[a-f0-9]{64}$/u;

type ArtifactPageState =
  | {
      readonly kind: "preview";
      readonly items: readonly RunArtifact[];
      readonly hasMore: boolean;
    }
  | {
      readonly kind: "loading";
      readonly items: readonly RunArtifact[];
      readonly cursor?: string;
      readonly replacingPreview: boolean;
    }
  | {
      readonly kind: "ready";
      readonly items: readonly RunArtifact[];
      readonly nextCursor?: string;
    }
  | {
      readonly kind: "error";
      readonly items: readonly RunArtifact[];
      readonly cursor?: string;
      readonly replacingPreview: boolean;
      readonly message: string;
    };

type InputPageState =
  | {
      readonly kind: "preview";
      readonly items: readonly RunInputRecord[];
      readonly hasMore: boolean;
    }
  | {
      readonly kind: "loading";
      readonly items: readonly RunInputRecord[];
      readonly cursor?: string;
      readonly replacingPreview: boolean;
    }
  | {
      readonly kind: "ready";
      readonly items: readonly RunInputRecord[];
      readonly nextCursor?: string;
    }
  | {
      readonly kind: "error";
      readonly items: readonly RunInputRecord[];
      readonly cursor?: string;
      readonly replacingPreview: boolean;
      readonly message: string;
    };

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly runs: readonly RunSummary[] };

type DetailState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly run: RunDetail };

type ActionState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving"; readonly message: string }
  | { readonly kind: "success"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

export function ReconciliationRuns() {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [detail, setDetail] = useState<DetailState>({ kind: "idle" });
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [showStart, setShowStart] = useState(false);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [policyVersion, setPolicyVersion] = useState("finance-close-v1");
  const [toleranceUsd, setToleranceUsd] = useState("0");
  const [dateWindowSeconds, setDateWindowSeconds] = useState("86400");
  const [graceSeconds, setGraceSeconds] = useState("3600");
  const [businessTimeZone, setBusinessTimeZone] = useState(defaultTimeZone);
  const [reason, setReason] = useState("");
  const [replayReason, setReplayReason] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setList({ kind: "loading" });
    void fetch("/api/recon?view=runs", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: readonly RunSummary[];
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setList({
            kind: "error",
            message: body.message ?? "Run history could not be loaded.",
          });
          return;
        }
        setList({ kind: "ready", runs: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setList({ kind: "error", message: "The run history API is unavailable." });
      });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!selectedId) {
      setDetail({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setDetail({ kind: "loading" });
    void fetch(`/api/recon?view=run&id=${encodeURIComponent(selectedId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: RunDetail;
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setDetail({
            kind: "error",
            message: body.message ?? "Run evidence could not be loaded.",
          });
          return;
        }
        setDetail({ kind: "ready", run: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDetail({ kind: "error", message: "The run evidence API is unavailable." });
      });
    return () => controller.abort();
  }, [reload, selectedId]);

  const hasActiveRun = useMemo(
    () =>
      list.kind === "ready" &&
      list.runs.some((run) => run.status === "queued" || run.status === "running"),
    [list],
  );

  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setTimeout(() => setReload((value) => value + 1), 5000);
    return () => window.clearTimeout(timer);
  }, [hasActiveRun, reload]);

  async function startRun() {
    const dateWindow = Number(dateWindowSeconds);
    const graceWindow = Number(graceSeconds);
    if (
      reason.trim().length < 3 ||
      !Number.isInteger(dateWindow) ||
      !Number.isInteger(graceWindow)
    ) {
      setAction({ kind: "error", message: "Complete every bounded policy field and reason." });
      return;
    }
    const confirmed = window.confirm(
      "Queue reconciliation against the latest canonical record versions? The exact inputs and policy will be pinned and the request will be audited.",
    );
    if (!confirmed) return;
    setAction({ kind: "saving", message: "Pinning inputs and queueing durable execution…" });
    let response: Response;
    try {
      response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "start_run",
          policyVersion,
          evaluatedAt: new Date().toISOString(),
          amountToleranceMinor: { USD: toleranceUsd },
          dateWindowSeconds: dateWindow,
          delayedEventGraceSeconds: graceWindow,
          businessTimeZone,
          reason,
        }),
      });
    } catch {
      setAction({ kind: "error", message: "The run request API is unavailable." });
      return;
    }
    const body = (await safeJson(response)) as {
      readonly data?: { readonly id: string; readonly status: RunStatus };
      readonly message?: string;
    };
    if (!response.ok || !body.data) {
      setAction({
        kind: "error",
        message: body.message ?? "The run request was not recorded.",
      });
      return;
    }
    setSelectedId(body.data.id);
    setReason("");
    setShowStart(false);
    setAction({
      kind: "success",
      message:
        body.data.status === "succeeded"
          ? "The identical immutable run already succeeded; its evidence is open."
          : "Durable run request recorded and queued.",
    });
    setReload((value) => value + 1);
  }

  async function replayRun(run: RunDetail) {
    if (replayReason.trim().length < 3) return;
    const confirmed = window.confirm(
      `Replay dispatch ${String(run.dispatchCount + 1)} against the same ${run.inputCount.toLocaleString("en-US")} pinned record versions? No newer source data will be read.`,
    );
    if (!confirmed) return;
    setAction({ kind: "saving", message: "Recording immutable-snapshot replay…" });
    let response: Response;
    try {
      response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "replay_run",
          runId: run.id,
          reason: replayReason,
        }),
      });
    } catch {
      setAction({ kind: "error", message: "The replay request API is unavailable." });
      return;
    }
    const body = (await safeJson(response)) as {
      readonly data?: { readonly accepted: boolean };
      readonly message?: string;
    };
    if (!response.ok || body.data?.accepted !== true) {
      setAction({
        kind: "error",
        message: body.message ?? "The replay request was not recorded.",
      });
      return;
    }
    setReplayReason("");
    setAction({ kind: "success", message: "Replay authority recorded and queued." });
    setReload((value) => value + 1);
  }

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Deterministic execution ledger</p>
          <h1>Reconciliation runs</h1>
          <p>
            Tenant-authorized run history with immutable input versions, policy hashes, engine
            versions, bounded errors, and recovery-only replay.
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="button button--secondary"
            disabled={list.kind === "loading"}
            onClick={() => setReload((value) => value + 1)}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={14} />
            Refresh
          </button>
          <button
            className="button button--primary"
            onClick={() => {
              setShowStart((value) => !value);
              setAction({ kind: "idle" });
            }}
            type="button"
          >
            {showStart ? <X aria-hidden="true" size={14} /> : <Play aria-hidden="true" size={14} />}
            {showStart ? "Close" : "Start run"}
          </button>
        </div>
      </section>

      {showStart ? (
        <section className="run-start-panel">
          <div className="run-start-panel__heading">
            <div>
              <h2>Pin a new run</h2>
              <p>
                “Evaluated at” is captured on confirmation. V1 does not perform currency conversion.
              </p>
            </div>
            <span className="source-boundary">
              <ShieldCheck aria-hidden="true" size={14} />
              Current canonical versions
            </span>
          </div>
          <div className="run-policy-grid">
            <label>
              <span>Policy version</span>
              <input
                maxLength={50}
                onChange={(event) => setPolicyVersion(event.target.value)}
                value={policyVersion}
              />
            </label>
            <label>
              <span>USD tolerance · minor units</span>
              <input
                inputMode="numeric"
                onChange={(event) => setToleranceUsd(event.target.value)}
                pattern="0|[1-9][0-9]{0,18}"
                value={toleranceUsd}
              />
            </label>
            <label>
              <span>Date window · seconds</span>
              <input
                inputMode="numeric"
                max={31 * 86_400}
                min={0}
                onChange={(event) => setDateWindowSeconds(event.target.value)}
                type="number"
                value={dateWindowSeconds}
              />
            </label>
            <label>
              <span>Delayed-event grace · seconds</span>
              <input
                inputMode="numeric"
                max={31 * 86_400}
                min={0}
                onChange={(event) => setGraceSeconds(event.target.value)}
                type="number"
                value={graceSeconds}
              />
            </label>
            <label>
              <span>Business time zone</span>
              <input
                maxLength={100}
                onChange={(event) => setBusinessTimeZone(event.target.value)}
                value={businessTimeZone}
              />
            </label>
            <label className="run-policy-grid__reason">
              <span>Reason · required and audit-visible</span>
              <textarea
                maxLength={2000}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this run being started?"
                rows={3}
                value={reason}
              />
            </label>
          </div>
          <div className="run-start-panel__actions">
            <p>Maximum snapshot: 100,000 records · maximum replay dispatches: 100</p>
            <button
              className="button button--primary"
              disabled={
                action.kind === "saving" ||
                reason.trim().length < 3 ||
                policyVersion.trim().length < 1
              }
              onClick={() => void startRun()}
              type="button"
            >
              <Play aria-hidden="true" size={14} />
              Confirm and queue
            </button>
          </div>
        </section>
      ) : null}

      <p
        aria-live="polite"
        className={`action-status action-status--${action.kind === "error" ? "failed" : action.kind}`}
      >
        {action.kind === "idle" ? "" : action.message}
      </p>

      <section className="queue-panel run-history">
        <div className="queue-toolbar">
          <div>
            <h2>Latest 50 runs</h2>
            <p>Queued and running rows refresh every five seconds while this page is open.</p>
          </div>
          {hasActiveRun ? <span className="run-live-indicator">Execution active</span> : null}
        </div>
        {list.kind === "loading" ? (
          <div aria-busy="true" className="workspace-loading">
            <LoaderCircle aria-hidden="true" className="spin" size={22} />
            Loading run authority…
          </div>
        ) : null}
        {list.kind === "error" ? (
          <StatePanel icon="error" title="Run history unavailable" message={list.message} />
        ) : null}
        {list.kind === "ready" && list.runs.length === 0 ? (
          <StatePanel
            icon="empty"
            title="No reconciliation runs"
            message="Start the first run only after canonical source records and policy are ready."
          />
        ) : null}
        {list.kind === "ready" && list.runs.length > 0 ? (
          <div className="table-scroll" tabIndex={0}>
            <table className="run-table">
              <caption className="visually-hidden">
                Latest tenant reconciliation runs in reverse chronological order
              </caption>
              <thead>
                <tr>
                  <th scope="col">Requested</th>
                  <th scope="col">Status</th>
                  <th scope="col">Policy / engine</th>
                  <th scope="col">Input</th>
                  <th scope="col">Match</th>
                  <th scope="col">Exception</th>
                  <th scope="col">Queue authority</th>
                  <th scope="col">Dispatch</th>
                  <th scope="col">
                    <span className="visually-hidden">Inspect</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.runs.map((run) => (
                  <tr className={selectedId === run.id ? "is-selected" : undefined} key={run.id}>
                    <td>
                      <time dateTime={run.createdAt}>{formatTimestamp(run.createdAt)}</time>
                      <code title={run.id}>{shortHash(run.id)}</code>
                    </td>
                    <td>
                      <Status status={run.status} />
                      {run.lastErrorCode ? <small>{run.lastErrorCode}</small> : null}
                    </td>
                    <td>
                      <strong>{run.policyVersion}</strong>
                      <small>
                        rules {run.ruleSetVersion} · engine {run.engineVersion}
                      </small>
                    </td>
                    <td>{run.inputCount.toLocaleString("en-US")}</td>
                    <td>{run.matchCount.toLocaleString("en-US")}</td>
                    <td>{run.exceptionCount.toLocaleString("en-US")}</td>
                    <td>
                      <RunAuthority run={run} />
                    </td>
                    <td>
                      {run.dispatchCount}
                      {run.errorCount > 0 ? <small>{run.errorCount} error(s)</small> : null}
                    </td>
                    <td>
                      <button
                        aria-label={`Inspect run ${run.id}`}
                        className="row-action"
                        onClick={() => setSelectedId(run.id)}
                        type="button"
                      >
                        <FileClock aria-hidden="true" size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {selectedId ? (
        <RunEvidence
          detail={detail}
          onClose={() => setSelectedId(undefined)}
          onReplay={(run) => void replayRun(run)}
          replayReason={replayReason}
          setReplayReason={setReplayReason}
        />
      ) : null}
    </>
  );
}

function RunAuthority({ run }: { readonly run: RunSummary }) {
  if (run.status !== "succeeded") return <span className="run-authority">Not applied</span>;
  return (
    <span
      className={`run-authority ${
        run.operationalStateApplied ? "run-authority--applied" : "run-authority--historical"
      }`}
    >
      {run.operationalStateApplied ? "Live queue" : "Historical only"}
    </span>
  );
}

function RunEvidence({
  detail,
  onClose,
  onReplay,
  replayReason,
  setReplayReason,
}: {
  readonly detail: DetailState;
  readonly onClose: () => void;
  readonly onReplay: (run: RunDetail) => void;
  readonly replayReason: string;
  readonly setReplayReason: (value: string) => void;
}) {
  return (
    <section aria-label="Selected run evidence" className="run-evidence">
      <div className="run-evidence__heading">
        <div>
          <p className="eyebrow">Pinned execution evidence</p>
          <h2>Run detail</h2>
        </div>
        <button
          aria-label="Close run detail"
          className="row-action"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" size={15} />
        </button>
      </div>
      {detail.kind === "loading" ? (
        <div aria-busy="true" className="workspace-loading">
          <LoaderCircle aria-hidden="true" className="spin" size={22} />
          Loading immutable evidence…
        </div>
      ) : null}
      {detail.kind === "error" ? (
        <StatePanel icon="error" title="Run evidence unavailable" message={detail.message} />
      ) : null}
      {detail.kind === "ready" ? (
        <>
          <dl className="run-evidence-grid">
            <Evidence label="Status" value={humanize(detail.run.status)} />
            <Evidence
              label="Queue authority"
              value={
                detail.run.status !== "succeeded"
                  ? "Not applied"
                  : detail.run.operationalStateApplied
                    ? "Applied to live exception queue"
                    : "Historical result only — newer successful run retained authority"
              }
            />
            <Evidence label="Stable run key" value={detail.run.stableRunKey} mono />
            <Evidence label="Input snapshot SHA-256" value={detail.run.inputSnapshotHash} mono />
            <Evidence label="Policy snapshot SHA-256" value={detail.run.policySnapshotHash} mono />
            <Evidence label="Initiated by" value={detail.run.initiatedBy} mono />
            <Evidence
              label="Version context"
              value={`${detail.run.policyVersion} · rules ${detail.run.ruleSetVersion} · engine ${detail.run.engineVersion}`}
            />
          </dl>
          <div className="run-evidence__policy">
            <h3>Evaluated policy snapshot</h3>
            <pre>{JSON.stringify(detail.run.policySnapshot, null, 2)}</pre>
          </div>
          <RunInputEvidence run={detail.run} />
          <RunArtifactEvidence run={detail.run} />
          {["failed", "partial", "cancelled"].includes(detail.run.status) ? (
            <div className="run-replay">
              <div>
                <h3>Recovery replay</h3>
                <p>
                  Replay uses this exact input and policy snapshot. It cannot read newer canonical
                  records.
                </p>
              </div>
              <label>
                <span>Reason · required and audit-visible</span>
                <textarea
                  maxLength={2000}
                  onChange={(event) => setReplayReason(event.target.value)}
                  placeholder="Why is recovery replay appropriate?"
                  rows={3}
                  value={replayReason}
                />
              </label>
              <button
                className="button button--secondary"
                disabled={replayReason.trim().length < 3}
                onClick={() => onReplay(detail.run)}
                type="button"
              >
                <RotateCcw aria-hidden="true" size={14} />
                Confirm replay
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function RunInputEvidence({ run }: { readonly run: RunDetail }) {
  const [page, setPage] = useState<InputPageState>({
    kind: "preview",
    items: run.inputRecords,
    hasMore: run.inputRecordsTruncated,
  });
  const items = page.items;
  const nextCursor =
    page.kind === "ready" ? page.nextCursor : page.kind === "error" ? page.cursor : undefined;
  const canLoad =
    (page.kind === "preview" && page.hasMore) ||
    (page.kind === "ready" && page.nextCursor !== undefined) ||
    page.kind === "error";
  const replacingPreview =
    page.kind === "preview" || (page.kind === "error" && page.replacingPreview);

  async function loadPage(): Promise<void> {
    if (page.kind === "loading" || !canLoad) return;
    const cursor = nextCursor;
    const replace = replacingPreview;
    const retainedItems = replace ? [] : items;
    setPage({
      kind: "loading",
      items,
      ...(cursor ? { cursor } : {}),
      replacingPreview: replace,
    });
    const query = new URLSearchParams({ view: "run_inputs", id: run.id });
    if (cursor) query.set("cursor", cursor);
    try {
      const response = await fetch(`/api/recon?${query.toString()}`, { cache: "no-store" });
      const body = (await response.json()) as {
        readonly data?: unknown;
        readonly meta?: { readonly nextCursor?: unknown };
        readonly message?: string;
      };
      const responseItems = parseRunInputItems(body.data);
      const responseCursor = body.meta?.nextCursor;
      const validResponseCursor =
        responseCursor === undefined ||
        (typeof responseCursor === "string" && artifactCursorPattern.test(responseCursor));
      const retainedKeys = new Set(
        retainedItems.map(({ id, version }) => `${id}:${String(version)}`),
      );
      const responseOverlaps =
        responseItems?.some(({ id, version }) => retainedKeys.has(`${id}:${String(version)}`)) ??
        false;
      const lastOrdinal = retainedItems.at(-1)?.ordinal;
      const responseStartsAfterLast =
        lastOrdinal === undefined ||
        responseItems === undefined ||
        responseItems.length === 0 ||
        (responseItems[0]?.ordinal ?? -1) > lastOrdinal;
      const combinedItems = responseItems ? [...retainedItems, ...responseItems] : undefined;
      const responseCountIsConsistent =
        combinedItems !== undefined &&
        combinedItems.length <= run.inputCount &&
        (responseCursor !== undefined || combinedItems.length === run.inputCount);
      if (
        !response.ok ||
        !responseItems ||
        !combinedItems ||
        !validResponseCursor ||
        responseOverlaps ||
        !responseStartsAfterLast ||
        !responseCountIsConsistent ||
        (responseCursor !== undefined && responseItems.length === 0)
      ) {
        setPage({
          kind: "error",
          items,
          ...(cursor ? { cursor } : {}),
          replacingPreview: replace,
          message: body.message ?? "Pinned input lineage could not be loaded.",
        });
        return;
      }
      setPage({
        kind: "ready",
        items: combinedItems,
        ...(responseCursor ? { nextCursor: responseCursor } : {}),
      });
    } catch {
      setPage({
        kind: "error",
        items,
        ...(cursor ? { cursor } : {}),
        replacingPreview: replace,
        message: "Pinned input pagination is unavailable.",
      });
    }
  }

  return (
    <section aria-label="Pinned record versions" className="run-inputs">
      <div>
        <h3>Pinned record versions</h3>
        <p>
          Showing {items.length.toLocaleString("en-US")} of {run.inputCount.toLocaleString("en-US")}
          {page.kind === "preview" && page.hasMore ? " (bounded preview)" : ""}.
        </p>
      </div>
      {items.length > 0 ? (
        <div className="table-scroll" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Ordinal</th>
                <th scope="col">Record</th>
                <th scope="col">Version</th>
                <th scope="col">Content SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {items.map((record) => (
                <tr key={`${record.id}:${String(record.version)}`}>
                  <td>{record.ordinal}</td>
                  <td>
                    <code>{record.id}</code>
                  </td>
                  <td>{record.version}</td>
                  <td>
                    <code>{record.contentSha256}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="run-inputs__empty">This run pinned an empty canonical snapshot.</p>
      )}
      <div aria-live="polite">
        {page.kind === "preview" && page.hasMore ? (
          <p>
            This bounded input preview is truncated. Stable tenant-scoped pagination is available.
          </p>
        ) : null}
        {page.kind === "ready" && page.nextCursor ? (
          <p>Showing {page.items.length.toLocaleString("en-US")} pinned inputs; more remain.</p>
        ) : null}
        {page.kind === "ready" && !page.nextCursor ? (
          <p>All {page.items.length.toLocaleString("en-US")} pinned inputs are loaded.</p>
        ) : null}
        {page.kind === "error" ? <p role="alert">{page.message}</p> : null}
      </div>
      {canLoad || page.kind === "loading" ? (
        <button
          className="button button--secondary"
          disabled={page.kind === "loading"}
          onClick={() => void loadPage()}
          type="button"
        >
          {page.kind === "loading" ? (
            <LoaderCircle aria-hidden="true" className="spin" size={14} />
          ) : (
            <RefreshCw aria-hidden="true" size={14} />
          )}
          {page.kind === "loading"
            ? "Loading pinned inputs…"
            : replacingPreview
              ? "Browse all pinned inputs"
              : "Load more pinned inputs"}
        </button>
      ) : null}
    </section>
  );
}

function RunArtifactEvidence({ run }: { readonly run: RunDetail }) {
  const includesLegacyProjection = [...run.matches, ...run.exceptions].some(
    (artifact) => artifact.evidenceFidelity === "legacy_current_projection",
  );
  return (
    <div className="run-inputs">
      <div>
        <h3>Observed deterministic artifacts</h3>
        <p>
          Bounded per-run evidence: {run.matches.length.toLocaleString("en-US")} match
          {run.matches.length === 1 ? "" : "es"} and {run.exceptions.length.toLocaleString("en-US")}{" "}
          exception
          {run.exceptions.length === 1 ? "" : "s"}.
        </p>
      </div>
      {includesLegacyProjection ? (
        <div className="state-panel" role="status">
          <AlertTriangle aria-hidden="true" size={20} />
          <div>
            <strong>Legacy evidence projection present</strong>
            <p>
              At least one occurrence predates per-run snapshots. It is labeled as a current
              artifact projection and must not be treated as immutable historical evidence.
            </p>
          </div>
        </div>
      ) : null}
      <ArtifactTable
        artifacts={run.matches}
        emptyMessage="This run recorded no deterministic matches."
        key={`${run.id}:match`}
        runId={run.id}
        title="Matches"
        truncated={run.matchesTruncated}
        type="match"
      />
      <ArtifactTable
        artifacts={run.exceptions}
        emptyMessage="This run recorded no exceptions."
        key={`${run.id}:exception`}
        runId={run.id}
        title="Exceptions"
        truncated={run.exceptionsTruncated}
        type="exception"
      />
    </div>
  );
}

function ArtifactTable({
  artifacts,
  emptyMessage,
  runId,
  title,
  truncated,
  type,
}: {
  readonly artifacts: readonly RunArtifact[];
  readonly emptyMessage: string;
  readonly runId: string;
  readonly title: string;
  readonly truncated: boolean;
  readonly type: RunArtifactType;
}) {
  const [page, setPage] = useState<ArtifactPageState>({
    kind: "preview",
    items: artifacts,
    hasMore: truncated,
  });
  const items = page.items;
  const nextCursor =
    page.kind === "ready" ? page.nextCursor : page.kind === "error" ? page.cursor : undefined;
  const canLoad =
    (page.kind === "preview" && page.hasMore) ||
    (page.kind === "ready" && page.nextCursor !== undefined) ||
    page.kind === "error";
  const replacingPreview =
    page.kind === "preview" || (page.kind === "error" && page.replacingPreview);

  async function loadPage(): Promise<void> {
    if (page.kind === "loading" || !canLoad) return;
    const cursor = nextCursor;
    const replace = replacingPreview;
    const retainedItems = replace ? [] : items;
    setPage({
      kind: "loading",
      items,
      ...(cursor ? { cursor } : {}),
      replacingPreview: replace,
    });
    const query = new URLSearchParams({
      view: "run_artifacts",
      id: runId,
      type,
    });
    if (cursor) query.set("cursor", cursor);
    try {
      const response = await fetch(`/api/recon?${query.toString()}`, { cache: "no-store" });
      const body = (await response.json()) as {
        readonly data?: {
          readonly type?: unknown;
          readonly items?: unknown;
        };
        readonly meta?: { readonly nextCursor?: unknown };
        readonly message?: string;
      };
      const responseItems = parseRunArtifactItems(body.data?.items, type);
      const responseCursor = body.meta?.nextCursor;
      const validResponseCursor =
        responseCursor === undefined ||
        (typeof responseCursor === "string" && artifactCursorPattern.test(responseCursor));
      if (!response.ok || body.data?.type !== type || !responseItems || !validResponseCursor) {
        setPage({
          kind: "error",
          items,
          ...(cursor ? { cursor } : {}),
          replacingPreview: replace,
          message: body.message ?? `${title} could not be loaded.`,
        });
        return;
      }
      const seen = new Set(retainedItems.map(({ id }) => id));
      const combined = [...retainedItems, ...responseItems.filter(({ id }) => !seen.has(id))];
      setPage({
        kind: "ready",
        items: combined,
        ...(responseCursor ? { nextCursor: responseCursor } : {}),
      });
    } catch {
      setPage({
        kind: "error",
        items,
        ...(cursor ? { cursor } : {}),
        replacingPreview: replace,
        message: `${title} pagination is unavailable.`,
      });
    }
  }

  return (
    <section aria-label={`${title} observed in this run`}>
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p className="run-inputs__empty">{emptyMessage}</p>
      ) : (
        <div className="table-scroll" tabIndex={0}>
          <table className="run-artifact-table">
            <thead>
              <tr>
                <th scope="col">{title === "Matches" ? "Rule" : "Type"}</th>
                <th scope="col">Reason</th>
                <th scope="col">Records</th>
                <th scope="col">Observed</th>
                <th scope="col">Evidence fidelity</th>
                <th scope="col">
                  <span className="visually-hidden">Evidence detail</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((artifact) => {
                const isException = "type" in artifact;
                return (
                  <tr key={artifact.id}>
                    <td>
                      <div className="run-artifact-identity">
                        {isException ? (
                          <Link href={`/dashboard/exceptions/${artifact.id}`}>
                            {humanize(artifact.type)}
                          </Link>
                        ) : (
                          <strong>{humanize(artifact.ruleId)}</strong>
                        )}
                        {isException ? (
                          <small>
                            observed {humanize(artifact.observedStatus)} · current{" "}
                            {humanize(artifact.currentStatus)}
                          </small>
                        ) : (
                          <small>rule {artifact.ruleVersion}</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <code>{artifactReasonCode(artifact.evidence)}</code>
                    </td>
                    <td>
                      {artifactRecordCount(
                        artifact.recordReferences,
                        artifact.recordReferencesStatus,
                      )}
                    </td>
                    <td>
                      <time dateTime={artifact.observedAt}>
                        {formatTimestamp(artifact.observedAt)}
                      </time>
                    </td>
                    <td>
                      <span
                        className={`run-artifact-fidelity run-artifact-fidelity--${
                          artifact.evidenceFidelity === "exact_at_observation" ? "exact" : "legacy"
                        }`}
                      >
                        {artifact.evidenceFidelity === "exact_at_observation"
                          ? "Exact at observation"
                          : "Legacy current projection"}
                      </span>
                    </td>
                    <td>
                      <details>
                        <summary>View evidence</summary>
                        <ArtifactEvidenceDetail evidence={artifact.evidence} />
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div aria-live="polite">
        {page.kind === "preview" && page.hasMore ? (
          <p>This bounded preview is truncated. Stable tenant-scoped pagination is available.</p>
        ) : null}
        {page.kind === "ready" && page.nextCursor ? (
          <p>
            Showing {page.items.length.toLocaleString("en-US")} {title.toLocaleLowerCase("en-US")};
            more remain.
          </p>
        ) : null}
        {page.kind === "ready" && !page.nextCursor ? (
          <p>
            All {page.items.length.toLocaleString("en-US")} {title.toLocaleLowerCase("en-US")} for
            this run are loaded.
          </p>
        ) : null}
        {page.kind === "error" ? <p role="alert">{page.message}</p> : null}
      </div>
      {canLoad || page.kind === "loading" ? (
        <button
          className="button button--secondary"
          disabled={page.kind === "loading"}
          onClick={() => void loadPage()}
          type="button"
        >
          {page.kind === "loading" ? (
            <LoaderCircle aria-hidden="true" className="spin" size={14} />
          ) : (
            <RefreshCw aria-hidden="true" size={14} />
          )}
          {page.kind === "loading"
            ? `Loading ${title.toLocaleLowerCase("en-US")}…`
            : replacingPreview
              ? `Browse all ${title.toLocaleLowerCase("en-US")}`
              : `Load more ${title.toLocaleLowerCase("en-US")}`}
        </button>
      ) : null}
    </section>
  );
}

function Evidence({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? "is-mono" : undefined}>{value}</dd>
    </div>
  );
}

function ArtifactEvidenceDetail({ evidence }: { readonly evidence: DeterministicEvidenceView }) {
  if (evidence.status === "unavailable") {
    return (
      <p className="run-artifact-evidence-unavailable">
        Stored evidence is malformed or unsupported. No unvalidated fields are shown.
      </p>
    );
  }
  return (
    <div className="run-artifact-evidence">
      <dl>
        <Evidence label="Rule" value={`${evidence.ruleId} v${evidence.ruleVersion}`} mono />
        <Evidence label="Rule set" value={evidence.ruleSetVersion} mono />
        <Evidence label="Result" value={humanize(evidence.result)} />
        <Evidence
          label="Tolerance"
          value={
            evidence.toleranceMinor === undefined
              ? "Not applied"
              : `${evidence.toleranceMinor} minor units`
          }
        />
        <Evidence
          label="Source records"
          value={`${evidence.sourceRecordCount.toLocaleString("en-US")}${
            evidence.evidenceTruncated ? " · evidence truncated" : ""
          }`}
        />
        <Evidence label="Evaluated" value={formatTimestamp(evidence.evaluatedAt)} />
      </dl>
      {evidence.comparisons.length > 0 ? (
        <div className="run-artifact-comparisons">
          {evidence.comparisons.map((comparison, index) => (
            <section
              aria-label={`Comparison ${String(index + 1)}`}
              key={comparisonKey(comparison, index)}
            >
              <strong>Comparison {index + 1}</strong>
              <div>
                <ComparisonValues label="Source representation" value={comparison.source} />
                <ComparisonValues label="Normalized value" value={comparison.normalized} />
              </div>
            </section>
          ))}
        </div>
      ) : (
        <p className="run-artifact-evidence-unavailable">No value comparison was recorded.</p>
      )}
    </div>
  );
}

function ComparisonValues({
  label,
  value,
}: {
  readonly label: string;
  readonly value: Readonly<Record<string, string>>;
}) {
  return (
    <dl>
      <div>
        <dt>{label}</dt>
        <dd>
          {Object.entries(value).map(([key, item]) => (
            <span className="run-artifact-comparison-value" key={key}>
              <strong>{humanize(key)}</strong>
              <code>{item}</code>
            </span>
          ))}
        </dd>
      </div>
    </dl>
  );
}

function comparisonKey(
  comparison: {
    readonly source: Readonly<Record<string, string>>;
    readonly normalized: Readonly<Record<string, string>>;
  },
  index: number,
): string {
  return `${String(index)}:${Object.keys(comparison.source)[0] ?? "source"}:${
    Object.keys(comparison.normalized)[0] ?? "normalized"
  }`;
}

function Status({ status }: { readonly status: RunStatus }) {
  return <span className={`run-status run-status--${status}`}>{humanize(status)}</span>;
}

function StatePanel({
  icon,
  title,
  message,
}: {
  readonly icon: "error" | "empty";
  readonly title: string;
  readonly message: string;
}) {
  return (
    <div className={`state-panel ${icon === "error" ? "state-panel--error" : ""}`} role="status">
      {icon === "error" ? (
        <AlertTriangle aria-hidden="true" size={22} />
      ) : (
        <Archive aria-hidden="true" size={22} />
      )}
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
    </div>
  );
}

function parseRunArtifactItems(
  value: unknown,
  type: RunArtifactType,
): readonly RunArtifact[] | undefined {
  if (!isUnknownArray(value)) return undefined;
  if (!value.every((item): item is RunArtifact => isRunArtifact(item, type))) return undefined;
  return value;
}

function parseRunInputItems(value: unknown): readonly RunInputRecord[] | undefined {
  if (!isUnknownArray(value)) return undefined;
  if (!value.every((item): item is RunInputRecord => isRunInputRecord(item))) return undefined;
  const identities = new Set<string>();
  for (const [index, item] of value.entries()) {
    const previous = value[index - 1];
    if (previous && item.ordinal <= previous.ordinal) return undefined;
    const identity = `${item.id}:${String(item.version)}`;
    if (identities.has(identity)) return undefined;
    identities.add(identity);
  }
  return value;
}

function isRunInputRecord(value: unknown): value is RunInputRecord {
  if (!isUnknownRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    uuidPattern.test(value["id"]) &&
    typeof value["version"] === "number" &&
    Number.isInteger(value["version"]) &&
    value["version"] >= 1 &&
    typeof value["contentSha256"] === "string" &&
    sha256Pattern.test(value["contentSha256"]) &&
    typeof value["ordinal"] === "number" &&
    Number.isInteger(value["ordinal"]) &&
    value["ordinal"] >= 0 &&
    value["ordinal"] < 100_000
  );
}

function isRunArtifact(value: unknown, type: RunArtifactType): value is RunArtifact {
  if (!isUnknownRecord(value)) return false;
  if (
    typeof value["id"] !== "string" ||
    !uuidPattern.test(value["id"]) ||
    typeof value["observedAt"] !== "string" ||
    !isInstant(value["observedAt"]) ||
    !isRecordReferenceState(value["recordReferences"], value["recordReferencesStatus"]) ||
    !isDeterministicEvidenceView(value["evidence"]) ||
    !["exact_at_observation", "legacy_current_projection"].includes(
      String(value["evidenceFidelity"]),
    )
  ) {
    return false;
  }
  if (type === "match") {
    return typeof value["ruleId"] === "string" && typeof value["ruleVersion"] === "string";
  }
  return (
    typeof value["type"] === "string" &&
    value["type"].length > 0 &&
    value["type"].length <= 200 &&
    typeof value["observedStatus"] === "string" &&
    value["observedStatus"].length > 0 &&
    value["observedStatus"].length <= 200 &&
    typeof value["currentStatus"] === "string" &&
    value["currentStatus"].length > 0 &&
    value["currentStatus"].length <= 200 &&
    ["high", "medium", "low"].includes(String(value["severity"]))
  );
}

function isRecordReferenceState(references: unknown, status: unknown): boolean {
  if (status !== "available" && status !== "unavailable") return false;
  if (
    !Array.isArray(references) ||
    references.length > 500 ||
    !references.every((reference) => typeof reference === "string" && uuidPattern.test(reference))
  ) {
    return false;
  }
  return status === "available" || references.length === 0;
}

function isDeterministicEvidenceView(value: unknown): value is DeterministicEvidenceView {
  if (
    !isUnknownRecord(value) ||
    value["schemaVersion"] !== "deterministic-evidence-view-v1" ||
    (value["status"] !== "available" && value["status"] !== "unavailable")
  ) {
    return false;
  }
  if (value["status"] === "unavailable") {
    return value["reasonCode"] === "EVIDENCE_UNSUPPORTED_OR_MALFORMED";
  }
  if (
    !isBoundedString(value["ruleId"], 200) ||
    !isBoundedString(value["ruleVersion"], 100) ||
    !isBoundedString(value["ruleSetVersion"], 100) ||
    !isSafeCount(value["sourceRecordCount"], 100_000) ||
    typeof value["evidenceTruncated"] !== "boolean" ||
    !Array.isArray(value["comparisons"]) ||
    value["comparisons"].length > 500 ||
    !value["comparisons"].every(isEvidenceComparison) ||
    (value["toleranceMinor"] !== undefined &&
      (typeof value["toleranceMinor"] !== "string" ||
        !/^(0|[1-9][0-9]{0,18})$/u.test(value["toleranceMinor"]))) ||
    (value["candidateSearch"] !== undefined && !isCandidateSearch(value["candidateSearch"])) ||
    (value["accountingCandidateSearch"] !== undefined &&
      !isAccountingCandidateSearch(value["accountingCandidateSearch"])) ||
    !["pass", "fail", "defer", "ambiguous"].includes(String(value["result"])) ||
    !isBoundedString(value["reasonCode"], 200) ||
    typeof value["evaluatedAt"] !== "string" ||
    !isInstant(value["evaluatedAt"])
  ) {
    return false;
  }
  return true;
}

function isEvidenceComparison(value: unknown): boolean {
  return (
    isUnknownRecord(value) &&
    isComparisonValue(value["source"]) &&
    isComparisonValue(value["normalized"])
  );
}

function isComparisonValue(value: unknown): boolean {
  if (!isUnknownRecord(value) || Object.keys(value).length > 20) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      key.length >= 1 && key.length <= 100 && typeof item === "string" && item.length <= 4_096,
  );
}

function isCandidateSearch(value: unknown): boolean {
  return (
    isUnknownRecord(value) &&
    isSafeCount(value["eligibleCount"], 100_000) &&
    isSafeCount(value["evaluatedCount"], 500) &&
    isSafeCount(value["emittedCount"], 5) &&
    isSafeCount(value["evaluationLimit"], 500) &&
    value["evaluationLimit"] >= 1 &&
    typeof value["complete"] === "boolean"
  );
}

function isAccountingCandidateSearch(value: unknown): boolean {
  return (
    isUnknownRecord(value) &&
    isSafeCount(value["eligibleCountLowerBound"], 100_000) &&
    isSafeCount(value["evaluationLimit"], 500) &&
    value["evaluationLimit"] >= 1 &&
    value["complete"] === false
  );
}

function isSafeCount(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function isInstant(value: string): boolean {
  return value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function artifactReasonCode(evidence: DeterministicEvidenceView): string {
  return evidence.status === "available" ? evidence.reasonCode : "UNAVAILABLE";
}

function artifactRecordCount(
  recordReferences: readonly string[],
  status: "available" | "unavailable",
): string {
  return status === "available" ? recordReferences.length.toLocaleString("en-US") : "Unavailable";
}

function humanize(value: string): string {
  const text = value.replaceAll("_", " ").toLocaleLowerCase("en-US");
  return text.charAt(0).toLocaleUpperCase("en-US") + text.slice(1);
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}…` : value;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
