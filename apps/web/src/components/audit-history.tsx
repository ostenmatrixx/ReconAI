"use client";

import { AlertTriangle, Archive, LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface AuditEvent {
  readonly id: string;
  readonly actorType: "user" | "worker" | "system" | "support";
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly reason?: string;
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly events: readonly AuditEvent[] };

export function AuditHistory() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [query, setQuery] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/recon?view=audit", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: readonly AuditEvent[];
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setState({
            kind: "error",
            message: body.message ?? "Audit history could not be loaded.",
          });
          return;
        }
        setState({ kind: "ready", events: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "The tenant audit API is unavailable." });
      });
    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    if (state.kind !== "ready") return [];
    const normalized = query.trim().toLocaleLowerCase("en-US");
    if (!normalized) return state.events;
    return state.events.filter((event) =>
      [
        event.action,
        event.resourceType,
        event.resourceId,
        event.actorType,
        event.actorId,
        event.reason ?? "",
        event.correlationId,
      ].some((value) => value.toLocaleLowerCase("en-US").includes(normalized)),
    );
  }, [query, state]);

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Evidence ledger</p>
          <h1>Audit history</h1>
          <p>
            Latest tenant-authorized actor, action, resource, reason, and correlation evidence.
            Stored events are hash-chained and append-only.
          </p>
        </div>
        <span className="source-boundary">Latest 100 events</span>
      </section>
      <section className="queue-panel audit-panel">
        <div className="queue-toolbar">
          <div>
            <h2>Organization event history</h2>
            <p>Search affects only the loaded bounded result; it never changes evidence.</p>
          </div>
          <label className="audit-search">
            <Search aria-hidden="true" size={14} />
            <span className="visually-hidden">Search loaded audit history</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Action, resource, actor, reason"
              type="search"
              value={query}
            />
          </label>
        </div>
        {state.kind === "loading" ? (
          <div aria-busy="true" className="workspace-loading">
            <LoaderCircle aria-hidden="true" className="spin" size={22} />
            Loading append-only history…
          </div>
        ) : null}
        {state.kind === "error" ? (
          <div className="state-panel state-panel--error" role="alert">
            <AlertTriangle aria-hidden="true" size={22} />
            <div>
              <strong>Audit history unavailable</strong>
              <p>{state.message}</p>
            </div>
          </div>
        ) : null}
        {state.kind === "ready" && state.events.length === 0 ? (
          <div className="state-panel">
            <Archive aria-hidden="true" size={22} />
            <div>
              <strong>No audit events are available</strong>
              <p>This is an empty history state, not an assurance that no activity occurred.</p>
            </div>
          </div>
        ) : null}
        {state.kind === "ready" && state.events.length > 0 && filtered.length === 0 ? (
          <div className="state-panel">
            <Search aria-hidden="true" size={22} />
            <div>
              <strong>No loaded events match this search</strong>
              <p>Clear the search to restore the latest bounded organization history.</p>
            </div>
          </div>
        ) : null}
        {filtered.length > 0 ? <AuditTable events={filtered} /> : null}
      </section>
    </>
  );
}

function AuditTable({ events }: { readonly events: readonly AuditEvent[] }) {
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="audit-table">
        <caption className="visually-hidden">
          Latest organization audit events in reverse chronological order
        </caption>
        <thead>
          <tr>
            <th scope="col">Occurred</th>
            <th scope="col">Action</th>
            <th scope="col">Actor</th>
            <th scope="col">Resource</th>
            <th scope="col">Reason</th>
            <th scope="col">Correlation</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>
                <time dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time>
              </td>
              <td>
                <strong>{humanize(event.action)}</strong>
              </td>
              <td>
                <span>{humanize(event.actorType)}</span>
                <code>{shortId(event.actorId)}</code>
              </td>
              <td>
                <span>{humanize(event.resourceType)}</span>
                <code title={event.resourceId}>{shortId(event.resourceId)}</code>
              </td>
              <td>{event.reason ?? "—"}</td>
              <td>
                <code title={event.correlationId}>{shortId(event.correlationId)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function humanize(value: string): string {
  const normalized = value.replaceAll("_", " ").replaceAll(".", " / ");
  return normalized.charAt(0).toLocaleUpperCase("en-US") + normalized.slice(1);
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}…` : value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
