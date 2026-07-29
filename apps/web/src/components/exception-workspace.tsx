"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock3,
  FileCheck2,
  Fingerprint,
  GitCompareArrows,
  History,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
  UserCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

interface Proposal {
  readonly id: string;
  readonly version: number;
  readonly type: string;
  readonly reason: string;
  readonly status: string;
  readonly canRevise: boolean;
  readonly approvalCount: number;
  readonly requiredApprovals: number;
  readonly createdAt: string;
}

interface ExceptionDetail {
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
  readonly updatedAt: string;
  readonly recordReferences: readonly string[];
  readonly recordReferencesStatus: "available" | "unavailable";
  readonly evidence: DeterministicEvidenceView;
  readonly sourceRecords?: readonly SourceRecordEvidence[];
  readonly assigneeMembershipId?: string;
  readonly deferredUntil?: string;
  readonly notes?: readonly ExceptionNote[];
  readonly timeline?: readonly ExceptionTimelineEvent[];
  readonly timelineTruncated?: boolean;
  readonly latestProposal?: Proposal;
}

interface ExceptionNote {
  readonly id: string;
  readonly authorMembershipId: string;
  readonly authorEmail?: string;
  readonly body: string;
  readonly createdAt: string;
}

interface ExceptionTimelineEvent {
  readonly id: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly actorType: "user" | "worker" | "system" | "support";
  readonly actorId?: string;
  readonly reason?: string;
  readonly occurredAt: string;
}

interface SourceRecordEvidence {
  readonly id: string;
  readonly version: number;
  readonly kind: string;
  readonly source: string;
  readonly sourceTimestamp: string;
  readonly normalizedData: Readonly<Record<string, unknown>>;
  readonly contentSha256: string;
  readonly fieldProvenanceStatus: "available" | "unavailable";
  readonly fieldProvenance: readonly {
    readonly fieldPath: string;
    readonly normalizedValue: string;
    readonly transformationRule: string;
    readonly transformationVersion: string;
    readonly warnings: readonly string[];
  }[];
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

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: ExceptionDetail };

const supportedProposalTypes = [
  "investigate_source_record",
  "document_external_payment",
  "manual_override",
  "write_off",
] as const;

export function ExceptionWorkspace({ exceptionId }: { readonly exceptionId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reason, setReason] = useState("");
  const [proposalType, setProposalType] = useState<string>("investigate_source_record");
  const [workflowReason, setWorkflowReason] = useState("");
  const [deferredUntil, setDeferredUntil] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [actionState, setActionState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/recon?view=exception&id=${encodeURIComponent(exceptionId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: ExceptionDetail;
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setState({ kind: "error", message: body.message ?? "Exception could not be loaded." });
          return;
        }
        setProposalType(body.data.latestProposal?.type ?? "investigate_source_record");
        setState({ kind: "ready", value: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "The evidence API is unavailable." });
      });
    return () => controller.abort();
  }, [exceptionId, reload]);

  if (state.kind === "loading") {
    return (
      <div aria-busy="true" className="workspace-loading">
        <LoaderCircle aria-hidden="true" className="spin" size={22} />
        Loading immutable evidence…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="state-panel state-panel--error" role="alert">
        <AlertTriangle aria-hidden="true" size={22} />
        <div>
          <strong>Investigation unavailable</strong>
          <p>{state.message}</p>
        </div>
      </div>
    );
  }

  const item = state.value;
  const sourceRecords = item.sourceRecords ?? [];
  const notes = item.notes ?? [];
  const timeline = item.timeline ?? [];
  const proposal = item.latestProposal;
  const canComposeProposal =
    !proposal ||
    ["rejected", "superseded"].includes(proposal.status) ||
    (proposal.status === "pending" && proposal.canRevise);
  const proposalTypeOptions = supportedProposalTypes.includes(
    proposalType as (typeof supportedProposalTypes)[number],
  )
    ? supportedProposalTypes
    : [proposalType, ...supportedProposalTypes];
  const candidateOverflow = readCandidateOverflow(item.evidence);

  async function submitAction(
    body:
      | {
          readonly action: "create_proposal";
          readonly exceptionId: string;
          readonly type: string;
          readonly reason: string;
        }
      | {
          readonly action: "decide_proposal";
          readonly proposalId: string;
          readonly decision: "approve" | "reject";
          readonly reason: string;
        }
      | {
          readonly action: "add_note";
          readonly exceptionId: string;
          readonly body: string;
        }
      | {
          readonly action: "update_exception";
          readonly exceptionId: string;
          readonly workflowAction: "assign_self" | "reopen";
          readonly reason: string;
        }
      | {
          readonly action: "update_exception";
          readonly exceptionId: string;
          readonly workflowAction: "defer";
          readonly deferredUntil: string;
          readonly reason: string;
        },
  ) {
    setActionState("saving");
    try {
      const response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setActionState("failed");
        return;
      }
    } catch {
      setActionState("failed");
      return;
    }
    setReason("");
    setWorkflowReason("");
    setDeferredUntil("");
    setNoteBody("");
    setActionState("saved");
    setReload((value) => value + 1);
  }

  return (
    <>
      <Link className="back-link" href="/dashboard">
        <ArrowLeft aria-hidden="true" size={15} />
        Exception queue
      </Link>
      <section className="investigation-heading">
        <div>
          <p className="eyebrow">Exception investigation</p>
          <h1>{humanize(item.type)}</h1>
          <div className="investigation-meta">
            <span className={`severity severity--${item.severity}`}>
              <span aria-hidden="true">●</span>
              {humanize(item.severity)}
            </span>
            <span>
              <Clock3 aria-hidden="true" size={13} />
              Observed {formatDate(item.createdAt)}
            </span>
            <code>{item.id}</code>
          </div>
        </div>
        <span className="source-boundary">No external action</span>
      </section>

      {candidateOverflow ? (
        <section className="state-panel" role="status">
          <AlertTriangle aria-hidden="true" size={22} />
          <div>
            <strong>Candidate ranking withheld</strong>
            <p>
              {candidateOverflow.eligibleCount.toLocaleString("en-US")} eligible payments exceed the{" "}
              {candidateOverflow.evaluationLimit.toLocaleString("en-US")} record evaluation limit.
              No partial shortlist was produced; investigate the collision set manually.
            </p>
          </div>
        </section>
      ) : null}

      <div className="investigation-grid">
        <section className="evidence-panel">
          <div className="panel-title">
            <GitCompareArrows aria-hidden="true" size={17} />
            <div>
              <h2>Deterministic evidence</h2>
              <p>Values and rule output recorded at reconciliation time.</p>
            </div>
          </div>
          {item.evidence.status === "available" ? (
            <>
              <dl className="evidence-list evidence-list--summary">
                <div>
                  <dt>Rule</dt>
                  <dd>
                    <code>{item.evidence.ruleId}</code> v{item.evidence.ruleVersion}
                  </dd>
                </div>
                <div>
                  <dt>Rule set</dt>
                  <dd>{item.evidence.ruleSetVersion}</dd>
                </div>
                <div>
                  <dt>Result</dt>
                  <dd>{humanize(item.evidence.result)}</dd>
                </div>
                <div>
                  <dt>Review confidence</dt>
                  <dd>{humanize(item.confidence)}</dd>
                </div>
                <div>
                  <dt>Reason code</dt>
                  <dd>
                    <code>{item.evidence.reasonCode}</code>
                  </dd>
                </div>
                <div>
                  <dt>Tolerance</dt>
                  <dd>
                    {item.evidence.toleranceMinor === undefined
                      ? "Not applied"
                      : `${item.evidence.toleranceMinor} minor units`}
                  </dd>
                </div>
                <div>
                  <dt>Evaluated</dt>
                  <dd>
                    <time dateTime={item.evidence.evaluatedAt}>
                      {formatDate(item.evidence.evaluatedAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Source records</dt>
                  <dd>
                    {item.evidence.sourceRecordCount.toLocaleString("en-US")}
                    {item.evidence.evidenceTruncated ? " · evidence truncated" : ""}
                  </dd>
                </div>
                {item.evidence.candidateSearch ? (
                  <div>
                    <dt>Candidate search</dt>
                    <dd>
                      {item.evidence.candidateSearch.eligibleCount.toLocaleString("en-US")} eligible
                      · {item.evidence.candidateSearch.evaluatedCount.toLocaleString("en-US")}{" "}
                      evaluated ·{" "}
                      {item.evidence.candidateSearch.emittedCount.toLocaleString("en-US")} emitted ·{" "}
                      {item.evidence.candidateSearch.complete ? "complete" : "withheld"}
                    </dd>
                  </div>
                ) : null}
                {item.evidence.accountingCandidateSearch ? (
                  <div>
                    <dt>Accounting candidate search</dt>
                    <dd>
                      At least{" "}
                      {item.evidence.accountingCandidateSearch.eligibleCountLowerBound.toLocaleString(
                        "en-US",
                      )}{" "}
                      eligible · limit{" "}
                      {item.evidence.accountingCandidateSearch.evaluationLimit.toLocaleString(
                        "en-US",
                      )}{" "}
                      · withheld
                    </dd>
                  </div>
                ) : null}
              </dl>
              <div className="comparison-block">
                <h3>Source and normalized comparisons</h3>
                {item.evidence.comparisons.length > 0 ? (
                  <div className="table-scroll" tabIndex={0}>
                    <table className="evidence-comparison-table">
                      <thead>
                        <tr>
                          <th scope="col">Comparison</th>
                          <th scope="col">Source representation</th>
                          <th scope="col">Normalized value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {item.evidence.comparisons.map((comparison, index) => (
                          <tr key={comparisonKey(comparison, index)}>
                            <th scope="row">{index + 1}</th>
                            <td>
                              <ComparisonValues value={comparison.source} />
                            </td>
                            <td>
                              <ComparisonValues value={comparison.normalized} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="evidence-unavailable">No value comparison was recorded.</p>
                )}
              </div>
            </>
          ) : (
            <div className="state-panel state-panel--error" role="status">
              <AlertTriangle aria-hidden="true" size={20} />
              <div>
                <strong>Deterministic evidence unavailable</strong>
                <p>
                  The stored evidence is malformed or uses an unsupported contract. No unvalidated
                  fields were shown. Investigate the immutable run and source records before making
                  a decision.
                </p>
              </div>
            </div>
          )}
        </section>

        <aside aria-label="Human review controls" className="review-panel">
          <div className="panel-title">
            <ShieldCheck aria-hidden="true" size={17} />
            <div>
              <h2>Human control</h2>
              <p>Decisions update ReconAI only and are append-only audited.</p>
            </div>
          </div>

          <div className="workflow-control">
            <div className="workflow-control__status">
              <span>Workflow</span>
              <strong>{humanize(item.status)}</strong>
            </div>
            {item.assigneeMembershipId ? (
              <p>
                Assigned to <code>{item.assigneeMembershipId}</code>
              </p>
            ) : (
              <p>Unassigned</p>
            )}
            {item.deferredUntil ? (
              <p>
                Deferred until{" "}
                <time dateTime={item.deferredUntil}>{formatDate(item.deferredUntil)}</time>
              </p>
            ) : null}
            {["open", "assigned", "deferred"].includes(item.status) ? (
              <>
                <label>
                  <span>Workflow reason</span>
                  <input
                    maxLength={2000}
                    onChange={(event) => setWorkflowReason(event.target.value)}
                    placeholder="Required for the audit trail"
                    value={workflowReason}
                  />
                </label>
                {item.status !== "deferred" ? (
                  <label>
                    <span>Defer until</span>
                    <input
                      min={minimumDeferredLocalDate()}
                      onChange={(event) => setDeferredUntil(event.target.value)}
                      type="datetime-local"
                      value={deferredUntil}
                    />
                  </label>
                ) : null}
                <div className="workflow-control__actions">
                  <button
                    className="button button--secondary"
                    disabled={workflowReason.trim().length < 3 || actionState === "saving"}
                    onClick={() => {
                      if (
                        window.confirm(
                          item.status === "deferred"
                            ? "Reopen this exception now?"
                            : "Assign this exception to your membership?",
                        )
                      ) {
                        void submitAction({
                          action: "update_exception",
                          exceptionId,
                          workflowAction: item.status === "deferred" ? "reopen" : "assign_self",
                          reason: workflowReason,
                        });
                      }
                    }}
                    type="button"
                  >
                    <UserCheck aria-hidden="true" size={14} />
                    {item.status === "deferred" ? "Reopen" : "Assign to me"}
                  </button>
                  {item.status !== "deferred" ? (
                    <button
                      className="button button--secondary"
                      disabled={
                        workflowReason.trim().length < 3 ||
                        deferredUntil.length === 0 ||
                        actionState === "saving"
                      }
                      onClick={() => {
                        if (window.confirm("Defer this exception until the selected time?")) {
                          void submitAction({
                            action: "update_exception",
                            exceptionId,
                            workflowAction: "defer",
                            deferredUntil: new Date(deferredUntil).toISOString(),
                            reason: workflowReason,
                          });
                        }
                      }}
                      type="button"
                    >
                      <Clock3 aria-hidden="true" size={14} />
                      Defer
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="workflow-control__locked">
                Workflow controls are locked after proposal or terminal resolution.
              </p>
            )}
          </div>

          {proposal ? (
            <div className="proposal">
              <span className="proposal__label">Proposal v{proposal.version}</span>
              <strong>{humanize(proposal.type)}</strong>
              <p>{proposal.reason}</p>
              <div className="proposal__meta">
                <span>{humanize(proposal.status)}</span>
                <span>
                  {proposal.approvalCount}/{proposal.requiredApprovals} approvals
                </span>
                <time dateTime={proposal.createdAt}>{formatDate(proposal.createdAt)}</time>
              </div>
            </div>
          ) : (
            <div className="proposal proposal--empty">
              <FileCheck2 aria-hidden="true" size={20} />
              <strong>No resolution proposed</strong>
              <p>Document an investigation outcome before a reviewer can decide.</p>
            </div>
          )}

          {canComposeProposal ? (
            <label className="reason-field">
              <span>
                Resolution type <small>ReconAI-only proposal</small>
              </span>
              <select
                onChange={(event) => setProposalType(event.target.value)}
                value={proposalType}
              >
                {proposalTypeOptions.map((type) => (
                  <option key={type} value={type}>
                    {humanize(type)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="reason-field">
            <span>
              Reason <small>Required · audit visible</small>
            </span>
            <textarea
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
              placeholder="State the evidence and why this outcome is appropriate."
              rows={4}
              value={reason}
            />
          </label>

          {!proposal || ["rejected", "superseded"].includes(proposal.status) ? (
            <button
              className="button button--primary review-action"
              disabled={reason.trim().length < 3 || actionState === "saving"}
              onClick={() =>
                void submitAction({
                  action: "create_proposal",
                  exceptionId,
                  type: proposalType,
                  reason,
                })
              }
              type="button"
            >
              <FileCheck2 aria-hidden="true" size={15} />
              {proposal ? "Create revised proposal" : "Create proposal"}
            </button>
          ) : proposal.status === "pending" && proposal.canRevise ? (
            <button
              className="button button--primary review-action"
              disabled={reason.trim().length < 3 || actionState === "saving"}
              onClick={() => {
                if (
                  window.confirm(
                    `Revise proposal v${String(proposal.version)}? Its ${String(proposal.approvalCount)} recorded approval${
                      proposal.approvalCount === 1 ? "" : "s"
                    } will remain historical evidence but will not apply to the new version.`,
                  )
                ) {
                  void submitAction({
                    action: "create_proposal",
                    exceptionId,
                    type: proposalType,
                    reason,
                  });
                }
              }}
              type="button"
            >
              <FileCheck2 aria-hidden="true" size={15} />
              Revise proposal
            </button>
          ) : proposal.status === "pending" ? (
            <div className="decision-actions">
              <button
                className="button button--approve"
                disabled={reason.trim().length < 3 || actionState === "saving"}
                onClick={() =>
                  void submitAction({
                    action: "decide_proposal",
                    proposalId: proposal.id,
                    decision: "approve",
                    reason,
                  })
                }
                type="button"
              >
                <Check aria-hidden="true" size={15} />
                Approve
              </button>
              <button
                className="button button--reject"
                disabled={reason.trim().length < 3 || actionState === "saving"}
                onClick={() =>
                  void submitAction({
                    action: "decide_proposal",
                    proposalId: proposal.id,
                    decision: "reject",
                    reason,
                  })
                }
                type="button"
              >
                <X aria-hidden="true" size={15} />
                Reject
              </button>
            </div>
          ) : null}
          <p aria-live="polite" className={`action-status action-status--${actionState}`}>
            {actionState === "saving"
              ? "Recording audited action…"
              : actionState === "saved"
                ? "Action recorded."
                : actionState === "failed"
                  ? "Action failed. No decision was recorded."
                  : ""}
          </p>
        </aside>
      </div>

      <section className="history-panel">
        <div className="panel-title">
          <History aria-hidden="true" size={17} />
          <div>
            <h2>Investigation history</h2>
            <p>Append-only notes and a chronological audit timeline for this exception.</p>
          </div>
        </div>
        <div className="history-grid">
          <div className="notes-panel">
            <h3>
              <MessageSquareText aria-hidden="true" size={15} />
              Internal notes
            </h3>
            <div className="note-list">
              {notes.length > 0 ? (
                notes.map((note) => (
                  <article key={note.id}>
                    <header>
                      <strong>{note.authorEmail ?? note.authorMembershipId}</strong>
                      <time dateTime={note.createdAt}>{formatDate(note.createdAt)}</time>
                    </header>
                    <p>{note.body}</p>
                  </article>
                ))
              ) : (
                <p className="history-empty">No investigation notes yet.</p>
              )}
            </div>
            <label className="note-composer">
              <span>
                Add note <small>Permanent · 4,000 characters maximum</small>
              </span>
              <textarea
                maxLength={4000}
                onChange={(event) => setNoteBody(event.target.value)}
                placeholder="Record evidence checked, follow-up needed, or reviewer context."
                rows={4}
                value={noteBody}
              />
            </label>
            <button
              className="button button--secondary"
              disabled={noteBody.trim().length < 3 || actionState === "saving"}
              onClick={() => {
                if (window.confirm("Add this permanent internal investigation note?")) {
                  void submitAction({ action: "add_note", exceptionId, body: noteBody });
                }
              }}
              type="button"
            >
              <MessageSquareText aria-hidden="true" size={14} />
              Add permanent note
            </button>
          </div>
          <div className="timeline-panel">
            <h3>
              <History aria-hidden="true" size={15} />
              Audit timeline
            </h3>
            {item.timelineTruncated ? (
              <p className="timeline-warning">Showing the latest 500 events.</p>
            ) : null}
            <ol className="timeline-list">
              {timeline.length > 0 ? (
                timeline.map((event) => (
                  <li key={event.id}>
                    <span aria-hidden="true" />
                    <div>
                      <strong>{humanize(event.action)}</strong>
                      <p>
                        {humanize(event.actorType)}
                        {event.reason ? ` · ${event.reason}` : ""}
                      </p>
                      <time dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time>
                    </div>
                  </li>
                ))
              ) : (
                <li className="history-empty">No timeline events are available.</li>
              )}
            </ol>
          </div>
        </div>
      </section>

      <section className="provenance-panel">
        <div className="panel-title">
          <Fingerprint aria-hidden="true" size={17} />
          <div>
            <h2>Source record references</h2>
            <p>Versioned normalized values and field lineage; raw payload access is restricted.</p>
          </div>
        </div>
        {sourceRecords.length > 0 ? (
          <div className="source-record-grid">
            {sourceRecords.map((record) => (
              <article
                aria-label={`${humanize(record.source)} ${humanize(record.kind)} version ${record.version.toString()}`}
                className="source-record"
                key={`${record.id}:${record.version.toString()}`}
              >
                <header>
                  <div>
                    <strong>{humanize(record.source)}</strong>
                    <span>{humanize(record.kind)}</span>
                  </div>
                  <code>v{record.version}</code>
                </header>
                <dl>
                  {flatEvidence(record.normalizedData).map(([key, value]) => (
                    <div key={key}>
                      <dt>{humanize(key)}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="field-lineage">
                  <h3>Field lineage</h3>
                  {record.fieldProvenanceStatus === "available" ? (
                    <div className="table-scroll" tabIndex={0}>
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Field</th>
                            <th scope="col">Normalized value</th>
                            <th scope="col">Transformation</th>
                            <th scope="col">Warnings</th>
                          </tr>
                        </thead>
                        <tbody>
                          {record.fieldProvenance.map((field) => (
                            <tr key={`${field.fieldPath}:${field.transformationVersion}`}>
                              <th scope="row">{field.fieldPath}</th>
                              <td>{field.normalizedValue}</td>
                              <td>
                                {field.transformationRule} v{field.transformationVersion}
                              </td>
                              <td>
                                {field.warnings.length > 0 ? field.warnings.join(" · ") : "None"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="evidence-unavailable">
                      Field lineage is unavailable or malformed. No partial lineage is shown.
                    </p>
                  )}
                </div>
                <footer>
                  <span>{record.fieldProvenance.length} field lineage entries</span>
                  <time dateTime={record.sourceTimestamp}>
                    {formatDate(record.sourceTimestamp)}
                  </time>
                  <code title={record.contentSha256}>{record.contentSha256.slice(0, 12)}…</code>
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <p className="source-record-empty">Versioned source evidence is unavailable.</p>
        )}
        {item.recordReferencesStatus === "available" ? (
          <div className="reference-grid" aria-label="Canonical record references">
            {item.recordReferences.length > 0 ? (
              item.recordReferences.map((reference) => <code key={reference}>{reference}</code>)
            ) : (
              <p>No canonical record references were recorded.</p>
            )}
          </div>
        ) : (
          <p className="evidence-unavailable">
            Record references are malformed or exceed the display boundary. No partial list is
            shown.
          </p>
        )}
      </section>
    </>
  );
}

function flatEvidence(value: unknown, prefix = ""): readonly [string, string][] {
  if (value === null || value === undefined) return [["unavailable", "Not recorded"]];
  if (typeof value !== "object") return [[prefix || "value", displayScalar(value)]];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      flatEvidence(item, `${prefix} ${String(index + 1)}`.trim()),
    );
  }
  return Object.entries(value).flatMap(([key, item]) => {
    const next = [prefix, key].filter(Boolean).join(" · ");
    return typeof item === "object" && item !== null
      ? flatEvidence(item, next)
      : [[next, displayScalar(item)] as const];
  });
}

function displayScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "Unsupported evidence value";
}

function ComparisonValues({ value }: { readonly value: Readonly<Record<string, string>> }) {
  return (
    <dl className="comparison-values">
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <dt>{humanize(key)}</dt>
          <dd>{item}</dd>
        </div>
      ))}
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
  const firstSourceKey = Object.keys(comparison.source)[0] ?? "source";
  const firstNormalizedKey = Object.keys(comparison.normalized)[0] ?? "normalized";
  return `${String(index)}:${firstSourceKey}:${firstNormalizedKey}`;
}

function humanize(value: string): string {
  const normalized = value
    .replaceAll("_", " ")
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll("·", " / ")
    .trim();
  return normalized.charAt(0).toLocaleUpperCase("en-US") + normalized.slice(1);
}

function readCandidateOverflow(
  value: DeterministicEvidenceView,
): { readonly eligibleCount: number; readonly evaluationLimit: number } | undefined {
  if (
    value.status !== "available" ||
    value.reasonCode !== "ORDER_PAYMENT_CANDIDATE_SET_EXCEEDS_LIMIT" ||
    value.candidateSearch === undefined
  ) {
    return undefined;
  }
  const search = value.candidateSearch;
  if (search.evaluatedCount !== 0 || search.emittedCount !== 0 || search.complete) {
    return undefined;
  }
  return {
    eligibleCount: search.eligibleCount,
    evaluationLimit: search.evaluationLimit,
  };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function minimumDeferredLocalDate(): string {
  const nextHour = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${nextHour.getFullYear().toString()}-${pad(nextHour.getMonth() + 1)}-${pad(
    nextHour.getDate(),
  )}T${pad(nextHour.getHours())}:${pad(nextHour.getMinutes())}`;
}
