"use client";

import { AlertTriangle, KeyRound, LoaderCircle, ShieldCheck, Unplug } from "lucide-react";
import { useEffect, useState } from "react";

import type { ConnectionHealthItem } from "./connector-health";

interface ConnectorCredentialMetadata {
  readonly id: string;
  readonly connectionId: string;
  readonly purpose: "webhook_signing" | "api_read";
  readonly status: "active" | "superseded" | "revoked";
  readonly keyVersion: string;
  readonly createdAt: string;
}

type CredentialState =
  | { readonly kind: "idle" | "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly ConnectorCredentialMetadata[] };

export function ConnectorCredentialControl({
  connections,
  onComplete,
}: {
  readonly connections: readonly ConnectionHealthItem[];
  readonly onComplete: () => void;
}) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [purpose, setPurpose] = useState<"webhook_signing" | "api_read">("api_read");
  const [envelopeText, setEnvelopeText] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [disconnectReason, setDisconnectReason] = useState("");
  const [disconnectConfirmation, setDisconnectConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [providerActionUrl, setProviderActionUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [credentialReload, setCredentialReload] = useState(0);
  const [state, setState] = useState<CredentialState>({ kind: "idle" });
  const selectedConnection = connections.find((connection) => connection.id === connectionId);

  useEffect(() => {
    if (!connections.some((connection) => connection.id === connectionId)) {
      setConnectionId(connections[0]?.id ?? "");
    }
  }, [connectionId, connections]);

  useEffect(() => {
    if (!connectionId) {
      setState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    void fetch(
      `/api/recon?view=connector_credentials&connectionId=${encodeURIComponent(connectionId)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly data?: readonly ConnectorCredentialMetadata[];
          readonly message?: string;
        };
        if (!response.ok || !body.data) {
          setState({
            kind: "error",
            message:
              body.message ?? "Credential metadata is available only to connector administrators.",
          });
          return;
        }
        setState({ kind: "ready", items: body.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "Credential metadata could not be loaded." });
      });
    return () => controller.abort();
  }, [connectionId, credentialReload]);

  async function rotateCredential() {
    let envelope: unknown;
    try {
      envelope = JSON.parse(envelopeText) as unknown;
    } catch {
      setFailed(true);
      setMessage("Paste one valid sealed credential envelope.");
      return;
    }
    if (!connectionId || reason.trim().length < 3 || !confirmed) {
      setFailed(true);
      setMessage("Select a connection, provide an audit reason, and confirm the rotation.");
      return;
    }
    setPending(true);
    setFailed(false);
    setMessage(undefined);
    setProviderActionUrl(undefined);
    try {
      const response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "rotate_connector_credential",
          connectionId,
          purpose,
          envelope,
          confirmed: true,
          reason,
        }),
      });
      const body = (await response.json()) as {
        readonly data?: {
          readonly id: string;
          readonly keyVersion: string;
        };
        readonly message?: string;
      };
      if (!response.ok || !body.data) {
        setFailed(true);
        setMessage(body.message ?? "The sealed credential could not be installed.");
        return;
      }
      setMessage(`Credential ${body.data.id} is active under key ${body.data.keyVersion}.`);
      setEnvelopeText("");
      setReason("");
      setConfirmed(false);
      setCredentialReload((value) => value + 1);
      onComplete();
    } catch {
      setFailed(true);
      setMessage("The connector credential API is unavailable.");
    } finally {
      setPending(false);
    }
  }

  async function disconnect() {
    if (
      !connectionId ||
      disconnectConfirmation !== connectionId ||
      disconnectReason.trim().length < 3
    ) {
      setFailed(true);
      setMessage("Enter an audit reason and the exact connection ID to disconnect.");
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
          action: "disconnect_connector",
          connectionId,
          confirmConnectionId: disconnectConfirmation,
          reason: disconnectReason,
        }),
      });
      const body = (await response.json()) as {
        readonly data?:
          | {
              readonly status: "disconnected";
              readonly revoked: number;
              readonly providerConfirmation: "confirmed" | "not_recorded";
            }
          | {
              readonly status: "provider_action_required";
              readonly providerActionUrl: string;
              readonly providerConfirmation: "pending";
            };
        readonly message?: string;
      };
      if (!response.ok || !body.data) {
        setFailed(true);
        setMessage(body.message ?? "The connection could not be disconnected.");
        return;
      }
      if (body.data.status === "provider_action_required") {
        const actionUrl = safeStripeSettingsUrl(body.data.providerActionUrl);
        if (!actionUrl) {
          setFailed(true);
          setMessage("Stripe returned an invalid provider action destination.");
          return;
        }
        setProviderActionUrl(actionUrl);
        setMessage(
          "ReconAI read access is stopped. Uninstall the app in Stripe to confirm provider revocation.",
        );
      } else {
        setMessage(
          body.data.providerConfirmation === "confirmed"
            ? `Provider revocation confirmed; ${String(body.data.revoked)} active credentials revoked locally.`
            : "The connection was already locally disconnected; provider confirmation was not repeated or inferred.",
        );
      }
      setDisconnectReason("");
      setDisconnectConfirmation("");
      setCredentialReload((value) => value + 1);
      onComplete();
    } catch {
      setFailed(true);
      setMessage("The connector credential API is unavailable.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="queue-panel" aria-labelledby="credential-lifecycle-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Encrypted credential lifecycle</p>
          <h2 id="credential-lifecycle-heading">Provider credential authority</h2>
          <p>
            Seal provider credentials locally, then install only the authenticated ciphertext
            envelope. Raw tokens never enter this browser or the ReconAI JSON API.
          </p>
        </div>
        <span className="source-boundary">
          <ShieldCheck aria-hidden="true" size={14} />
          Tenant-bound encryption
        </span>
      </div>
      {connections.length === 0 ? (
        <div className="state-panel">
          <KeyRound aria-hidden="true" size={22} />
          <div>
            <strong>No provider connection available</strong>
            <p>Create a Shopify or Stripe connection before installing credential authority.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="run-start-panel">
            <div className="run-policy-grid">
              <label>
                <span>Credential connection</span>
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
                <span>Credential purpose</span>
                <select
                  disabled={pending}
                  onChange={(event) =>
                    setPurpose(event.target.value as "webhook_signing" | "api_read")
                  }
                  value={purpose}
                >
                  <option value="api_read">Read API</option>
                  <option value="webhook_signing">Webhook signing</option>
                </select>
              </label>
              <label className="run-policy-grid__reason">
                <span>Sealed envelope JSON</span>
                <textarea
                  autoComplete="off"
                  disabled={pending}
                  maxLength={8192}
                  onChange={(event) => setEnvelopeText(event.target.value)}
                  placeholder='{"schemaVersion":1,"algorithm":"A256GCM",…}'
                  rows={5}
                  spellCheck={false}
                  value={envelopeText}
                />
              </label>
              <label className="run-policy-grid__reason">
                <span>Credential change reason · required and audit-visible</span>
                <textarea
                  disabled={pending}
                  maxLength={2000}
                  onChange={(event) => setReason(event.target.value)}
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
                  I confirm this envelope was sealed for connection <code>{connectionId}</code> and
                  contains a read-only provider credential for the selected purpose.
                </span>
              </label>
            </div>
            <div className="run-start-panel__actions">
              <p>
                Active credentials are superseded atomically. Retired ciphertext remains append-only
                audit evidence.
              </p>
              <button
                className="button button--primary"
                disabled={
                  pending ||
                  !confirmed ||
                  reason.trim().length < 3 ||
                  envelopeText.trim().length === 0
                }
                onClick={() => void rotateCredential()}
                type="button"
              >
                {pending ? (
                  <LoaderCircle aria-hidden="true" className="spin" size={14} />
                ) : (
                  <KeyRound aria-hidden="true" size={14} />
                )}
                Install or rotate
              </button>
            </div>
          </div>
          <details>
            <summary className="button button--secondary">
              <Unplug aria-hidden="true" size={14} />
              Disconnect provider
            </summary>
            <div className="inline-form">
              <p>
                Shopify revocation is confirmed with Shopify before local credentials are retired.
                For Stripe, ReconAI stops new reads immediately and waits for Stripe&apos;s signed
                uninstall event before retiring encrypted credentials. A request already in flight
                may finish.
              </p>
              <label>
                Disconnect audit reason
                <input
                  disabled={pending}
                  onChange={(event) => setDisconnectReason(event.target.value)}
                  value={disconnectReason}
                />
              </label>
              <label>
                Type the exact connection ID
                <input
                  autoComplete="off"
                  disabled={pending}
                  onChange={(event) => setDisconnectConfirmation(event.target.value)}
                  value={disconnectConfirmation}
                />
              </label>
              <button
                className="button button--secondary"
                disabled={
                  pending ||
                  disconnectReason.trim().length < 3 ||
                  disconnectConfirmation !== connectionId
                }
                onClick={() => void disconnect()}
                type="button"
              >
                <Unplug aria-hidden="true" size={14} />
                Request provider disconnect
              </button>
            </div>
          </details>
        </>
      )}
      {message ? (
        <p
          aria-live="polite"
          className={`action-status action-status--${failed ? "failed" : "saved"}`}
        >
          {message}
        </p>
      ) : null}
      {providerActionUrl ? (
        <p className="action-status action-status--saved">
          <a href={providerActionUrl} rel="noreferrer" target="_blank">
            Open Stripe app settings to uninstall
          </a>
        </p>
      ) : null}
      {state.kind === "loading" ? (
        <div aria-busy="true" className="workspace-loading">
          <LoaderCircle aria-hidden="true" className="spin" size={22} />
          Loading credential metadata…
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div className="state-panel state-panel--error" role="status">
          <AlertTriangle aria-hidden="true" size={22} />
          <div>
            <strong>Credential management unavailable</strong>
            <p>{state.message}</p>
          </div>
        </div>
      ) : null}
      {state.kind === "ready" && state.items.length > 0 ? (
        <div className="table-scroll" tabIndex={0}>
          <table>
            <caption className="visually-hidden">
              Connector credential lifecycle metadata without ciphertext
            </caption>
            <thead>
              <tr>
                <th scope="col">Purpose</th>
                <th scope="col">State</th>
                <th scope="col">Key version</th>
                <th scope="col">Created</th>
                <th scope="col">Credential ID</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((credential) => (
                <tr key={credential.id}>
                  <td>{humanize(credential.purpose)}</td>
                  <td>{humanize(credential.status)}</td>
                  <td>
                    <code>{credential.keyVersion}</code>
                  </td>
                  <td>{formatTimestamp(credential.createdAt)}</td>
                  <td>
                    <code>{credential.id}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {selectedConnection ? (
        <p className="muted-copy">
          Selected authority: {humanize(selectedConnection.provider)} ·{" "}
          <code>{selectedConnection.id}</code>
        </p>
      ) : null}
    </section>
  );
}

function safeStripeSettingsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://dashboard.stripe.com" ||
      !/^\/settings\/apps\/[A-Za-z0-9._-]{3,255}$/u.test(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

function formatTimestamp(value?: string): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}
