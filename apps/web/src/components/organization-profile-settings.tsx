"use client";

import { AlertTriangle, Building2, LoaderCircle, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

interface OrganizationProfile {
  readonly name: string;
  readonly businessTimeZone: string;
  readonly profileVersion: number;
  readonly updatedAt: string;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly profile: OrganizationProfile };

const organizationProfileUpdatedEvent = "reconai:organization-profile-updated";

export function OrganizationProfileSettings() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [reload, setReload] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "conflict" | "failed">(
    "idle",
  );
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void fetch("/api/recon?view=organization_profile", {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as unknown;
        const profile = organizationProfileFromResponse(body);
        if (!response.ok || !profile) {
          setState({
            kind: "error",
            message: response.ok
              ? "The organization profile response was invalid."
              : (responseMessage(body) ?? "The organization profile could not be loaded."),
          });
          return;
        }
        setName(profile.name);
        setState({ kind: "ready", profile });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "The organization profile API is unavailable." });
      });
    return () => controller.abort();
  }, [reload]);

  const normalizedName = name.trim();
  const canSave =
    state.kind === "ready" &&
    saveState !== "saving" &&
    normalizedName.length > 0 &&
    normalizedName.length <= 200 &&
    !containsControlCharacter(normalizedName) &&
    normalizedName !== state.profile.name &&
    reason.trim().length >= 3 &&
    reason.trim().length <= 2000 &&
    !containsControlCharacter(reason);

  async function saveProfile() {
    if (!canSave) return;
    const confirmed = window.confirm(
      `Rename this organization to “${normalizedName}”? The change is visible to every member and will be recorded in the audit history.`,
    );
    if (!confirmed) return;

    setSaveState("saving");
    setSaveMessage("");
    try {
      const response = await fetch("/api/recon/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "update_organization_profile",
          name: normalizedName,
          expectedProfileVersion: state.profile.profileVersion,
          reason,
        }),
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      const body = (await response.json()) as unknown;
      if (response.status === 409) {
        setSaveState("conflict");
        setSaveMessage(
          "Another administrator changed this profile. The current version has been reloaded; review it before trying again.",
        );
        setReason("");
        setReload((value) => value + 1);
        return;
      }
      const profile = organizationProfileFromResponse(body);
      if (!response.ok || !profile) {
        setSaveState("failed");
        setSaveMessage(responseMessage(body) ?? "The organization profile was not updated.");
        return;
      }

      setName(profile.name);
      setReason("");
      setState({ kind: "ready", profile });
      setSaveState("saved");
      setSaveMessage("Organization name updated and recorded in the audit history.");
      window.dispatchEvent(
        new CustomEvent(organizationProfileUpdatedEvent, {
          detail: { name: profile.name },
        }),
      );
    } catch {
      setSaveState("failed");
      setSaveMessage("The organization profile API is unavailable.");
    }
  }

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Tenant identity and access</p>
          <h1>Organization settings</h1>
          <p>
            Manage the selected organization’s display name and authorized membership. Every
            accepted name change is version-checked and audit-visible.
          </p>
        </div>
        <span className="source-boundary">
          <ShieldCheck aria-hidden="true" size={14} />
          Tenant-authorized changes
        </span>
      </section>
      <section className="policy-panel">
        {state.kind === "loading" ? (
          <div aria-busy="true" className="workspace-loading">
            <LoaderCircle aria-hidden="true" className="spin" size={22} />
            Loading organization profile…
          </div>
        ) : null}
        {state.kind === "error" ? (
          <div className="state-panel state-panel--error" role="alert">
            <AlertTriangle aria-hidden="true" size={22} />
            <div>
              <strong>Organization profile unavailable</strong>
              <p>{state.message}</p>
            </div>
          </div>
        ) : null}
        {state.kind === "ready" ? (
          <>
            <div className="policy-panel__heading">
              <div>
                <p className="eyebrow">Selected organization</p>
                <h2>
                  <Building2 aria-hidden="true" size={20} /> Profile
                </h2>
                <p>
                  Business time zone is fixed at creation in this release because changing it can
                  alter business-date interpretation.
                </p>
              </div>
              <span>
                Version {state.profile.profileVersion.toString()} · Updated{" "}
                <time dateTime={state.profile.updatedAt}>
                  {formatTimestamp(state.profile.updatedAt)}
                </time>
              </span>
            </div>
            <form
              className="policy-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveProfile();
              }}
            >
              <label>
                Organization name
                <input
                  autoComplete="organization"
                  maxLength={200}
                  onChange={(event) => {
                    setName(event.target.value);
                    setSaveState("idle");
                    setSaveMessage("");
                  }}
                  required
                  value={name}
                />
              </label>
              <label>
                Business time zone · read only
                <input aria-readonly="true" readOnly value={state.profile.businessTimeZone} />
              </label>
              <label>
                Organization name change reason · required and audit-visible
                <textarea
                  maxLength={2000}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setSaveState("idle");
                    setSaveMessage("");
                  }}
                  placeholder="Why is this organization name changing?"
                  required
                  rows={3}
                  value={reason}
                />
              </label>
              <div className="policy-actions">
                <button className="button button--primary" disabled={!canSave} type="submit">
                  {saveState === "saving" ? (
                    <LoaderCircle aria-hidden="true" className="spin" size={15} />
                  ) : (
                    <Save aria-hidden="true" size={15} />
                  )}
                  {saveState === "saving" ? "Saving…" : "Save organization name"}
                </button>
                {saveMessage ? (
                  <p
                    aria-live="polite"
                    className={saveState === "saved" ? "action-success" : "action-error"}
                    role={saveState === "saved" ? "status" : "alert"}
                  >
                    {saveMessage}
                  </p>
                ) : null}
              </div>
            </form>
          </>
        ) : null}
      </section>
    </>
  );
}

function organizationProfileFromResponse(body: unknown): OrganizationProfile | undefined {
  if (!isRecord(body) || !isRecord(body.data)) return undefined;
  const keys = Object.keys(body.data).sort();
  if (
    keys.join(",") !== ["businessTimeZone", "name", "profileVersion", "updatedAt"].sort().join(",")
  ) {
    return undefined;
  }
  const { name, businessTimeZone, profileVersion, updatedAt } = body.data;
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 200 ||
    containsControlCharacter(name) ||
    typeof businessTimeZone !== "string" ||
    businessTimeZone.length < 1 ||
    businessTimeZone.length > 100 ||
    !Number.isSafeInteger(profileVersion) ||
    Number(profileVersion) < 1 ||
    typeof updatedAt !== "string" ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    return undefined;
  }
  return {
    name,
    businessTimeZone,
    profileVersion: Number(profileVersion),
    updatedAt,
  };
}

function responseMessage(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.message !== "string") return undefined;
  return body.message.length <= 500 ? body.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
  });
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
