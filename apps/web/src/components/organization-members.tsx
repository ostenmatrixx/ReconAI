"use client";

import { AlertTriangle, LoaderCircle, Pencil, Save, ShieldCheck, Users } from "lucide-react";
import { useEffect, useState } from "react";

import { OrganizationInvitations } from "./organization-invitations";

type Role = "owner" | "administrator" | "analyst" | "reviewer" | "auditor";
type MemberStatus = "active" | "deactivated";

interface OrganizationMember {
  readonly id: string;
  readonly userId: string;
  readonly email?: string;
  readonly role: Role;
  readonly status: "invited" | MemberStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly OrganizationMember[] };

export function OrganizationMembers({
  showPageHeading = true,
}: {
  readonly showPageHeading?: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [role, setRole] = useState<Role>("analyst");
  const [status, setStatus] = useState<MemberStatus>("active");
  const [reason, setReason] = useState("");
  const [actionState, setActionState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/recon?view=members", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: readonly OrganizationMember[];
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setState({
            kind: "error",
            message: body.message ?? "Membership data could not be loaded.",
          });
          return;
        }
        setState({ kind: "ready", items: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "The membership API is unavailable." });
      });
    return () => controller.abort();
  }, [reload]);

  function beginEdit(item: OrganizationMember) {
    setSelectedId(item.id);
    setRole(item.role);
    setStatus(item.status === "deactivated" ? "deactivated" : "active");
    setReason("");
    setActionState("idle");
  }

  async function saveMember() {
    if (!selectedId || reason.trim().length < 3) return;
    const confirmed = window.confirm(
      `Apply role “${humanize(role)}” and status “${humanize(status)}”? This changes organization access and will be audited.`,
    );
    if (!confirmed) return;
    setActionState("saving");
    const response = await fetch("/api/recon/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "update_member",
        membershipId: selectedId,
        role,
        status,
        reason,
      }),
    });
    if (!response.ok) {
      setActionState("failed");
      return;
    }
    setActionState("saved");
    setSelectedId(undefined);
    setReason("");
    setReload((value) => value + 1);
  }

  return (
    <>
      {showPageHeading ? (
        <section className="page-heading">
          <div>
            <p className="eyebrow">Organization access control</p>
            <h1>Members & roles</h1>
            <p>
              Current tenant membership from the authorization database. Role or status changes
              require a reason and produce append-only audit evidence.
            </p>
          </div>
          <span className="source-boundary">
            <ShieldCheck aria-hidden="true" size={14} />
            Owner lockout protected
          </span>
        </section>
      ) : null}
      <section className="queue-panel">
        {!showPageHeading ? (
          <div className="policy-panel__heading">
            <div>
              <p className="eyebrow">Organization access control</p>
              <h2>Members & roles</h2>
              <p>Role or status changes require a reason and produce append-only audit evidence.</p>
            </div>
            <span>Owner lockout protected</span>
          </div>
        ) : null}
        {state.kind === "loading" ? (
          <div aria-busy="true" className="workspace-loading">
            <LoaderCircle aria-hidden="true" className="spin" size={22} />
            Loading authorized members…
          </div>
        ) : null}
        {state.kind === "error" ? (
          <div className="state-panel state-panel--error" role="alert">
            <AlertTriangle aria-hidden="true" size={22} />
            <div>
              <strong>Membership controls unavailable</strong>
              <p>{state.message}</p>
            </div>
          </div>
        ) : null}
        {state.kind === "ready" && state.items.length === 0 ? (
          <div className="state-panel">
            <Users aria-hidden="true" size={22} />
            <div>
              <strong>No visible memberships</strong>
              <p>Organization access cannot be managed without an active authorized member.</p>
            </div>
          </div>
        ) : null}
        {state.kind === "ready" && state.items.length > 0 ? (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">
                Organization members, roles, and account status
              </caption>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="visually-hidden">Manage</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.email ?? "Identity email unavailable"}</strong>
                      <br />
                      <code>{item.userId.slice(0, 8)}</code>
                    </td>
                    <td>{humanize(item.role)}</td>
                    <td>
                      <span className="status-text">
                        <span aria-hidden="true">•</span>
                        {humanize(item.status)}
                      </span>
                    </td>
                    <td>{formatTimestamp(item.updatedAt)}</td>
                    <td>
                      <button
                        aria-label={`Manage ${item.email ?? item.userId}`}
                        className="row-action"
                        onClick={() => beginEdit(item)}
                        type="button"
                      >
                        <Pencil aria-hidden="true" size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {selectedId ? (
          <div className="member-editor">
            <div>
              <strong>Change member access</strong>
              <p>
                Self-mutation, owner escalation by administrators, and removal of the final active
                owner are rejected by the API.
              </p>
            </div>
            <label>
              <span>Role</span>
              <select onChange={(event) => setRole(event.target.value as Role)} value={role}>
                <option value="owner">Owner</option>
                <option value="administrator">Administrator</option>
                <option value="analyst">Analyst</option>
                <option value="reviewer">Reviewer</option>
                <option value="auditor">Read-only auditor</option>
              </select>
            </label>
            <label>
              <span>Status</span>
              <select
                onChange={(event) => setStatus(event.target.value as MemberStatus)}
                value={status}
              >
                <option value="active">Active</option>
                <option value="deactivated">Deactivated</option>
              </select>
            </label>
            <label className="member-editor__reason">
              <span>Reason · required and audit-visible</span>
              <textarea
                maxLength={2000}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this access change required?"
                rows={3}
                value={reason}
              />
            </label>
            <div className="member-editor__actions">
              <button
                className="button button--secondary"
                onClick={() => setSelectedId(undefined)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                disabled={reason.trim().length < 3 || actionState === "saving"}
                onClick={() => void saveMember()}
                type="button"
              >
                <Save aria-hidden="true" size={14} />
                Save access
              </button>
            </div>
          </div>
        ) : null}
        <p aria-live="polite" className={`action-status action-status--${actionState}`}>
          {actionState === "saving"
            ? "Recording audited membership change…"
            : actionState === "saved"
              ? "Membership change recorded."
              : actionState === "failed"
                ? "Access change failed. No update was recorded."
                : ""}
        </p>
      </section>
      <OrganizationInvitations />
    </>
  );
}

function humanize(value: string): string {
  const text = value.replaceAll("_", " ").toLocaleLowerCase("en-US");
  return text.charAt(0).toLocaleUpperCase("en-US") + text.slice(1);
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
