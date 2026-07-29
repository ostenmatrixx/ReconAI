"use client";

import { Cable, ExternalLink, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ConnectionHealthItem } from "./connector-health";

type Provider = "shopify" | "stripe";

export function ProviderAuthorizationControl({
  connections,
}: {
  readonly connections: readonly ConnectionHealthItem[];
}) {
  const [provider, setProvider] = useState<Provider>("shopify");
  const [connectionId, setConnectionId] = useState("");
  const [shop, setShop] = useState("");
  const [status, setStatus] = useState<
    "success" | "denied" | "error" | "reauthentication_required"
  >();
  const providerConnections = useMemo(
    () => connections.filter((connection) => connection.provider === provider),
    [connections, provider],
  );

  useEffect(() => {
    setConnectionId("");
  }, [provider]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("authorization");
    if (
      result === "success" ||
      result === "denied" ||
      result === "error" ||
      result === "reauthentication_required"
    ) {
      setStatus(result);
      url.searchParams.delete("authorization");
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);

  return (
    <section className="queue-panel" aria-labelledby="provider-authorization-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Provider-managed authorization</p>
          <h2 id="provider-authorization-heading">Connect a read-only account</h2>
          <p>
            Continue to Shopify or Stripe to grant the configured read permissions. ReconAI stores
            rotating access and refresh tokens only as tenant-bound authenticated ciphertext.
          </p>
        </div>
        <span className="source-boundary">
          <ShieldCheck aria-hidden="true" size={14} />
          No provider writes
        </span>
      </div>
      <form action="/api/recon/provider-authorizations" className="run-start-panel" method="post">
        <div className="run-policy-grid">
          <label>
            <span>Provider</span>
            <select
              name="provider"
              onChange={(event) => setProvider(event.target.value as Provider)}
              value={provider}
            >
              <option value="shopify">Shopify</option>
              <option value="stripe">Stripe</option>
            </select>
          </label>
          <label>
            <span>Connection target</span>
            <select
              name="connectionId"
              onChange={(event) => setConnectionId(event.target.value)}
              value={connectionId}
            >
              <option value="">Create a new connection</option>
              {providerConnections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  Reauthorize · {connection.externalAccountId}
                </option>
              ))}
            </select>
          </label>
          {provider === "shopify" && !connectionId ? (
            <label className="run-policy-grid__reason">
              <span>Canonical Shopify shop</span>
              <input
                autoComplete="off"
                maxLength={255}
                name="requestedAccountId"
                onChange={(event) => setShop(event.target.value)}
                pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com"
                placeholder="store-name.myshopify.com"
                required
                spellCheck={false}
                value={shop}
              />
            </label>
          ) : null}
        </div>
        <div className="run-start-panel__actions">
          <p>
            The authorization transaction expires after ten minutes and is bound to this signed-in
            user, organization, provider, and browser session.
          </p>
          <button className="button button--primary" type="submit">
            <ExternalLink aria-hidden="true" size={14} />
            Continue to {provider === "shopify" ? "Shopify" : "Stripe"}
          </button>
        </div>
      </form>
      {status ? (
        <div
          className={`state-panel ${status === "success" ? "" : "state-panel--error"}`}
          role={status === "success" ? "status" : "alert"}
        >
          <Cable aria-hidden="true" size={22} />
          <div>
            <strong>{authorizationStatus(status).title}</strong>
            <p>{authorizationStatus(status).message}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function authorizationStatus(
  status: "success" | "denied" | "error" | "reauthentication_required",
): { readonly title: string; readonly message: string } {
  if (status === "success") {
    return {
      title: "Provider account connected",
      message: "Encrypted read authority is active and the bounded initial backfill can begin.",
    };
  }
  if (status === "denied") {
    return {
      title: "Authorization cancelled",
      message: "The provider granted no authority. You can start a new authorization when ready.",
    };
  }
  if (status === "reauthentication_required") {
    return {
      title: "Sign in again",
      message: "Your ReconAI session expired while the provider authorization was in progress.",
    };
  }
  return {
    title: "Authorization not completed",
    message:
      "No new provider authority was activated. Start a fresh authorization or contact an administrator.",
  };
}
