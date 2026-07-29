"use client";

import {
  AlertTriangle,
  Ban,
  Clipboard,
  KeyRound,
  LoaderCircle,
  MailPlus,
  Send,
} from "lucide-react";
import { useEffect, useState } from "react";

type Role = "owner" | "administrator" | "analyst" | "reviewer" | "auditor";

interface OrganizationInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly status: "pending" | "accepted" | "revoked" | "expired";
  readonly expiresAt: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
  readonly createdAt: string;
}

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly OrganizationInvitation[] };

type ActionState = "idle" | "saving" | "saved" | "failed";
interface InvitationDeliveryState {
  readonly status: "accepted" | "not_configured" | "failed";
  readonly auditRecorded: boolean;
}

export function OrganizationInvitations() {
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("analyst");
  const [reason, setReason] = useState("");
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [deliveryState, setDeliveryState] = useState<InvitationDeliveryState>();
  const [oneTimeLink, setOneTimeLink] = useState<string>();
  const [revokeId, setRevokeId] = useState<string>();
  const [revokeReason, setRevokeReason] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/recon?view=invitations", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: readonly OrganizationInvitation[];
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setListState({
            kind: "error",
            message: body.message ?? "Invitation history could not be loaded.",
          });
          return;
        }
        setListState({ kind: "ready", items: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setListState({ kind: "error", message: "The invitation API is unavailable." });
      });
    return () => controller.abort();
  }, [reload]);

  async function createInvitation() {
    if (!email.trim() || reason.trim().length < 3) return;
    if (
      !window.confirm(
        `Invite ${email.trim()} as ${humanize(role)}? The one-time link grants organization access only to a matching provider-verified email.`,
      )
    ) {
      return;
    }
    setActionState("saving");
    setDeliveryState(undefined);
    setOneTimeLink(undefined);
    setCopyState("idle");
    const response = await fetch("/api/recon/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create_invitation",
        email,
        role,
        reason,
      }),
    });
    const body = (await response.json()) as {
      readonly data?: { readonly acceptToken?: string };
      readonly meta?: { readonly delivery?: InvitationDeliveryState };
    };
    if (!response.ok || !body.data?.acceptToken) {
      setActionState("failed");
      return;
    }
    const link = new URL("/invitations/accept", window.location.origin);
    link.hash = `token=${body.data.acceptToken}`;
    setOneTimeLink(link.toString());
    setDeliveryState(body.meta?.delivery ?? { status: "not_configured", auditRecorded: false });
    setEmail("");
    setReason("");
    setActionState("saved");
    setReload((value) => value + 1);
  }

  async function revokeInvitation() {
    if (!revokeId || revokeReason.trim().length < 3) return;
    if (
      !window.confirm("Revoke this invitation? Its bearer token will stop working immediately.")
    ) {
      return;
    }
    setActionState("saving");
    const response = await fetch("/api/recon/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "revoke_invitation",
        invitationId: revokeId,
        reason: revokeReason,
      }),
    });
    if (!response.ok) {
      setActionState("failed");
      return;
    }
    setRevokeId(undefined);
    setRevokeReason("");
    setActionState("saved");
    setReload((value) => value + 1);
  }

  async function copyInvitationLink() {
    if (!oneTimeLink) return;
    try {
      await navigator.clipboard.writeText(oneTimeLink);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <section aria-labelledby="invitation-heading" className="queue-panel invitation-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Controlled onboarding</p>
          <h2 id="invitation-heading">Organization invitations</h2>
          <p>
            Links expire after 72 hours, are single use, and only work for the invited
            provider-verified email.
          </p>
        </div>
        <KeyRound aria-hidden="true" size={22} />
      </div>

      <div className="member-editor invitation-create">
        <label>
          <span>Verified email</span>
          <input
            autoComplete="email"
            maxLength={320}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="reviewer@example.com"
            type="email"
            value={email}
          />
        </label>
        <label>
          <span>Initial role</span>
          <select onChange={(event) => setRole(event.target.value as Role)} value={role}>
            <option value="owner">Owner</option>
            <option value="administrator">Administrator</option>
            <option value="analyst">Analyst</option>
            <option value="reviewer">Reviewer</option>
            <option value="auditor">Read-only auditor</option>
          </select>
        </label>
        <label className="member-editor__reason">
          <span>Reason · required and audit-visible</span>
          <textarea
            maxLength={2000}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why does this person need organization access?"
            rows={3}
            value={reason}
          />
        </label>
        <div className="member-editor__actions">
          <button
            className="button button--primary"
            disabled={!email.trim() || reason.trim().length < 3 || actionState === "saving"}
            onClick={() => void createInvitation()}
            type="button"
          >
            <Send aria-hidden="true" size={14} />
            Create invitation
          </button>
        </div>
      </div>

      {oneTimeLink ? (
        <div className="invitation-secret" role="status">
          <MailPlus aria-hidden="true" size={20} />
          <div>
            <strong>
              {deliveryState?.status === "accepted"
                ? "Email delivery accepted. Copy this backup link now."
                : deliveryState?.status === "failed"
                  ? "Email delivery failed. Copy this link now."
                  : "Email delivery is not configured. Copy this link now."}
            </strong>
            <p>
              The bearer link will not be shown again. Share it only with the exact invited
              recipient through an approved channel.
              {deliveryState?.auditRecorded === false
                ? " The delivery outcome could not be added to audit history."
                : ""}
            </p>
            <textarea
              aria-label="One-time invitation link"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              rows={3}
              value={oneTimeLink}
            />
            <button
              className="button button--secondary"
              onClick={() => void copyInvitationLink()}
              type="button"
            >
              <Clipboard aria-hidden="true" size={14} />
              Copy link
            </button>
            <span aria-live="polite">
              {copyState === "copied"
                ? " Link copied."
                : copyState === "failed"
                  ? " Copy failed; select the link manually."
                  : ""}
            </span>
          </div>
        </div>
      ) : null}

      {listState.kind === "loading" ? (
        <div aria-busy="true" className="workspace-loading">
          <LoaderCircle aria-hidden="true" className="spin" size={22} />
          Loading invitation history…
        </div>
      ) : null}
      {listState.kind === "error" ? (
        <div className="state-panel state-panel--error" role="alert">
          <AlertTriangle aria-hidden="true" size={22} />
          <div>
            <strong>Invitation controls unavailable</strong>
            <p>{listState.message}</p>
          </div>
        </div>
      ) : null}
      {listState.kind === "ready" && listState.items.length === 0 ? (
        <div className="state-panel">
          <MailPlus aria-hidden="true" size={22} />
          <div>
            <strong>No invitation history</strong>
            <p>Create an invitation when a new organization member is ready to onboard.</p>
          </div>
        </div>
      ) : null}
      {listState.kind === "ready" && listState.items.length > 0 ? (
        <div className="table-scroll" tabIndex={0}>
          <table>
            <caption className="visually-hidden">Organization invitation history</caption>
            <thead>
              <tr>
                <th scope="col">Recipient</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="visually-hidden">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {listState.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.email}</td>
                  <td>{humanize(item.role)}</td>
                  <td>
                    <span className="status-text">
                      <span aria-hidden="true">•</span>
                      {humanize(item.status)}
                    </span>
                  </td>
                  <td>{formatTimestamp(item.expiresAt)}</td>
                  <td>
                    {item.status === "pending" ? (
                      <button
                        aria-label={`Revoke invitation for ${item.email}`}
                        className="row-action"
                        onClick={() => {
                          setRevokeId(item.id);
                          setRevokeReason("");
                          setActionState("idle");
                        }}
                        type="button"
                      >
                        <Ban aria-hidden="true" size={14} />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {revokeId ? (
        <div className="member-editor invitation-revoke">
          <div>
            <strong>Revoke invitation</strong>
            <p>The token becomes unusable and the transition remains in audit history.</p>
          </div>
          <label className="member-editor__reason">
            <span>Reason · required and audit-visible</span>
            <textarea
              maxLength={2000}
              onChange={(event) => setRevokeReason(event.target.value)}
              rows={3}
              value={revokeReason}
            />
          </label>
          <div className="member-editor__actions">
            <button
              className="button button--secondary"
              onClick={() => setRevokeId(undefined)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="button button--primary"
              disabled={revokeReason.trim().length < 3 || actionState === "saving"}
              onClick={() => void revokeInvitation()}
              type="button"
            >
              <Ban aria-hidden="true" size={14} />
              Revoke access link
            </button>
          </div>
        </div>
      ) : null}

      <p aria-live="polite" className={`action-status action-status--${actionState}`}>
        {actionState === "saving"
          ? "Recording the audited invitation change…"
          : actionState === "saved"
            ? deliveryState?.status === "accepted"
              ? "Invitation recorded and the email provider accepted delivery."
              : "Invitation recorded; use the one-time manual link."
            : actionState === "failed"
              ? "Invitation change failed. No requested access change was recorded."
              : ""}
      </p>
    </section>
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
