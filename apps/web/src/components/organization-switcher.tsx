"use client";

import { useEffect, useMemo, useState } from "react";

interface OrganizationOption {
  readonly id: string;
  readonly name: string;
  readonly role: "owner" | "administrator" | "analyst" | "reviewer" | "auditor";
}

interface OrganizationDirectory {
  readonly organizations: readonly OrganizationOption[];
  readonly selectedOrganizationId?: string;
  readonly nextCursor?: string;
  readonly accumulationLimitReached: boolean;
}

interface OrganizationBootstrapAttempt {
  readonly name: string;
  readonly businessTimeZone: string;
  readonly idempotencyKey: string;
}

type DirectoryState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly directory: OrganizationDirectory }
  | { readonly status: "error" };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const cursorPattern = /^[A-Za-z0-9_-]{1,1024}$/u;
const roles = new Set(["owner", "administrator", "analyst", "reviewer", "auditor"]);
const maximumAccumulatedOrganizations = 500;
const organizationProfileUpdatedEvent = "reconai:organization-profile-updated";

export function OrganizationSwitcher() {
  const [directoryState, setDirectoryState] = useState<DirectoryState>({ status: "loading" });
  const [draftOrganizationId, setDraftOrganizationId] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [bootstrapAttempt, setBootstrapAttempt] = useState<OrganizationBootstrapAttempt>();
  const [isDirectoryLoading, setIsDirectoryLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [selectionError, setSelectionError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void requestOrganizationDirectory("", undefined, controller.signal)
      .then((directory) => {
        setDirectoryState({ status: "ready", directory });
        setDraftOrganizationId(
          directory.selectedOrganizationId ?? directory.organizations[0]?.id ?? "",
        );
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setDirectoryState({ status: "error" });
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const updateSelectedName = (event: Event) => {
      const nextName = organizationNameFromUpdateEvent(event);
      if (!nextName) return;
      setDirectoryState((current) => {
        if (current.status !== "ready" || !current.directory.selectedOrganizationId) {
          return current;
        }
        const selectedOrganizationId = current.directory.selectedOrganizationId;
        return {
          status: "ready",
          directory: {
            ...current.directory,
            organizations: current.directory.organizations.map((organization) =>
              organization.id === selectedOrganizationId
                ? { ...organization, name: nextName }
                : organization,
            ),
          },
        };
      });
    };
    window.addEventListener(organizationProfileUpdatedEvent, updateSelectedName);
    return () => window.removeEventListener(organizationProfileUpdatedEvent, updateSelectedName);
  }, []);

  async function searchOrganizations(searchOverride?: string) {
    const search = (searchOverride ?? searchDraft).trim();
    if (search.length > 100 || containsControlCharacter(search)) {
      setSelectionError("Organization search is invalid.");
      return;
    }
    setIsDirectoryLoading(true);
    setSelectionError(undefined);
    try {
      const directory = await requestOrganizationDirectory(search);
      setDirectoryState({ status: "ready", directory });
      setActiveSearch(search);
      setDraftOrganizationId(
        directory.selectedOrganizationId ?? directory.organizations[0]?.id ?? "",
      );
    } catch {
      setSelectionError("Organization search failed. Try again.");
    } finally {
      setIsDirectoryLoading(false);
    }
  }

  async function loadMoreOrganizations() {
    if (directoryState.status !== "ready" || !directoryState.directory.nextCursor) return;
    setIsDirectoryLoading(true);
    setSelectionError(undefined);
    try {
      const next = await requestOrganizationDirectory(
        activeSearch,
        directoryState.directory.nextCursor,
      );
      const directory = mergeOrganizationDirectories(directoryState.directory, next);
      setDirectoryState({ status: "ready", directory });
    } catch {
      setSelectionError("More organizations could not be loaded. Try again.");
    } finally {
      setIsDirectoryLoading(false);
    }
  }

  const selectedOrganization = useMemo(
    () =>
      directoryState.status === "ready"
        ? directoryState.directory.organizations.find(
            ({ id }) => id === directoryState.directory.selectedOrganizationId,
          )
        : undefined,
    [directoryState],
  );

  async function selectOrganization() {
    if (
      directoryState.status !== "ready" ||
      !draftOrganizationId ||
      draftOrganizationId === directoryState.directory.selectedOrganizationId
    ) {
      return;
    }
    setIsSwitching(true);
    setSelectionError(undefined);
    try {
      const response = await fetch("/api/recon/organization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: draftOrganizationId }),
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      if (!response.ok) throw new Error("organization selection failed");
      window.location.assign("/dashboard");
    } catch {
      setSelectionError("Organization switch failed. Try again.");
      setIsSwitching(false);
    }
  }

  async function createOrganization() {
    const name = organizationName.trim();
    if (!name || name.length > 200 || containsControlCharacter(name)) {
      setSelectionError("Organization name is invalid.");
      return;
    }
    const attempt =
      bootstrapAttempt ??
      ({
        name,
        businessTimeZone: browserTimeZone(),
        idempotencyKey: crypto.randomUUID(),
      } satisfies OrganizationBootstrapAttempt);
    setBootstrapAttempt(attempt);
    setOrganizationName(attempt.name);
    setIsCreating(true);
    setSelectionError(undefined);
    try {
      const response = await fetch("/api/recon/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt),
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      if (response.status === 403) {
        setBootstrapAttempt(undefined);
        setSelectionError("A provider-verified email is required. Reauthenticate and try again.");
        setIsCreating(false);
        return;
      }
      if (response.status === 409) {
        setBootstrapAttempt(undefined);
        setSelectionError(
          "First-organization creation is no longer available. Reload tenant access.",
        );
        setIsCreating(false);
        return;
      }
      if (response.status === 400) {
        setBootstrapAttempt(undefined);
        setSelectionError("The organization request was rejected. Review the name and try again.");
        setIsCreating(false);
        return;
      }
      if (!response.ok) throw new Error("organization creation could not be confirmed");
      window.location.assign("/dashboard");
    } catch {
      setSelectionError(
        "Creation status could not be confirmed. Retry this same request or reload tenant access.",
      );
      setIsCreating(false);
    }
  }

  const monogram = selectedOrganization?.name.trim().charAt(0).toUpperCase() ?? "O";

  return (
    <div className="org-switcher">
      <span className="org-switcher__monogram" aria-hidden="true">
        {monogram}
      </span>
      <span className="org-switcher__body">
        <strong>{selectedOrganization?.name ?? "Select organization"}</strong>
        {directoryState.status === "loading" ? (
          <small aria-live="polite">Loading tenant access…</small>
        ) : directoryState.status === "error" ? (
          <small role="alert">Tenant access unavailable</small>
        ) : directoryState.directory.organizations.length === 0 && !activeSearch ? (
          <>
            <small>No active memberships</small>
            <form
              className="org-switcher__create"
              onSubmit={(event) => {
                event.preventDefault();
                void createOrganization();
              }}
            >
              <label className="visually-hidden" htmlFor="organization-name">
                Organization name
              </label>
              <input
                aria-label="Organization name"
                disabled={isCreating || bootstrapAttempt !== undefined}
                id="organization-name"
                maxLength={200}
                onChange={(event) => setOrganizationName(event.target.value)}
                placeholder="Organization name"
                required
                value={organizationName}
              />
              <button disabled={isCreating || organizationName.trim().length === 0} type="submit">
                {isCreating ? "Creating…" : bootstrapAttempt ? "Retry creation" : "Create"}
              </button>
            </form>
            <small>Verified email required · You become the first owner.</small>
            {selectionError ? <small role="alert">{selectionError}</small> : null}
          </>
        ) : (
          <>
            <form
              className="org-switcher__search"
              onSubmit={(event) => {
                event.preventDefault();
                void searchOrganizations();
              }}
            >
              <label className="visually-hidden" htmlFor="organization-search">
                Search organizations
              </label>
              <input
                aria-label="Search organizations"
                disabled={isDirectoryLoading || isSwitching}
                id="organization-search"
                maxLength={100}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Find organization"
                type="search"
                value={searchDraft}
              />
              <button disabled={isDirectoryLoading || isSwitching} type="submit">
                Search
              </button>
            </form>
            {directoryState.directory.organizations.length > 0 ? (
              <>
                <label className="visually-hidden" htmlFor="organization-context">
                  Organization
                </label>
                <span className="org-switcher__controls">
                  <select
                    aria-label="Organization"
                    disabled={isDirectoryLoading || isSwitching}
                    id="organization-context"
                    onChange={(event) => setDraftOrganizationId(event.target.value)}
                    value={draftOrganizationId}
                  >
                    {directoryState.directory.organizations.map((organization) => (
                      <option key={organization.id} value={organization.id}>
                        {organization.name} · {organization.role}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={
                      isDirectoryLoading ||
                      isSwitching ||
                      !draftOrganizationId ||
                      draftOrganizationId === directoryState.directory.selectedOrganizationId
                    }
                    onClick={() => void selectOrganization()}
                    type="button"
                  >
                    {isSwitching ? "Switching…" : "Switch"}
                  </button>
                  {directoryState.directory.nextCursor ? (
                    <button
                      disabled={isDirectoryLoading || isSwitching}
                      onClick={() => void loadMoreOrganizations()}
                      type="button"
                    >
                      {isDirectoryLoading ? "Loading…" : "More"}
                    </button>
                  ) : null}
                </span>
              </>
            ) : (
              <small>No organizations match this search.</small>
            )}
            {activeSearch ? (
              <small>
                Results for “{activeSearch}” ·{" "}
                <button
                  className="org-switcher__clear"
                  disabled={isDirectoryLoading || isSwitching}
                  onClick={() => {
                    setSearchDraft("");
                    void searchOrganizations("");
                  }}
                  type="button"
                >
                  Clear
                </button>
              </small>
            ) : null}
            {directoryState.directory.accumulationLimitReached ? (
              <small>Refine search to see additional memberships.</small>
            ) : null}
            {selectionError ? <small role="alert">{selectionError}</small> : null}
          </>
        )}
      </span>
    </div>
  );
}

function parseOrganizationDirectory(value: unknown): OrganizationDirectory {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.meta)) {
    throw new Error("invalid directory");
  }
  const organizations = value.data.organizations;
  if (
    !Array.isArray(organizations) ||
    organizations.length > 100 ||
    (value.meta.nextCursor !== undefined &&
      (typeof value.meta.nextCursor !== "string" || !cursorPattern.test(value.meta.nextCursor)))
  ) {
    throw new Error("invalid directory");
  }
  const parsedOrganizations = organizations.map(parseOrganizationOption);
  const selectedOrganization =
    value.data.selectedOrganization === undefined
      ? undefined
      : parseOrganizationOption(value.data.selectedOrganization);
  const selected =
    typeof value.data.selectedOrganizationId === "string" &&
    uuidPattern.test(value.data.selectedOrganizationId)
      ? value.data.selectedOrganizationId
      : undefined;
  if (selectedOrganization && selectedOrganization.id !== selected) {
    throw new Error("invalid directory");
  }
  const unique = new Map(
    parsedOrganizations.map((organization) => [organization.id, organization]),
  );
  if (selectedOrganization) unique.set(selectedOrganization.id, selectedOrganization);
  return {
    organizations: [...unique.values()],
    ...(selected ? { selectedOrganizationId: selected } : {}),
    ...(typeof value.meta.nextCursor === "string" ? { nextCursor: value.meta.nextCursor } : {}),
    accumulationLimitReached: false,
  };
}

async function requestOrganizationDirectory(
  search: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<OrganizationDirectory> {
  const query = new URLSearchParams({ view: "organizations" });
  if (search) query.set("search", search);
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`/api/recon?${query.toString()}`, {
    cache: "no-store",
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error("organization directory request failed");
  return parseOrganizationDirectory(await response.json());
}

function mergeOrganizationDirectories(
  current: OrganizationDirectory,
  next: OrganizationDirectory,
): OrganizationDirectory {
  const organizations = new Map(
    [...current.organizations, ...next.organizations].map((organization) => [
      organization.id,
      organization,
    ]),
  );
  const bounded = [...organizations.values()].slice(0, maximumAccumulatedOrganizations);
  const accumulationLimitReached =
    organizations.size > maximumAccumulatedOrganizations ||
    (bounded.length === maximumAccumulatedOrganizations && next.nextCursor !== undefined);
  return {
    organizations: bounded,
    ...(current.selectedOrganizationId
      ? { selectedOrganizationId: current.selectedOrganizationId }
      : next.selectedOrganizationId
        ? { selectedOrganizationId: next.selectedOrganizationId }
        : {}),
    ...(!accumulationLimitReached && next.nextCursor ? { nextCursor: next.nextCursor } : {}),
    accumulationLimitReached,
  };
}

function parseOrganizationOption(organization: unknown): OrganizationOption {
  if (
    !isRecord(organization) ||
    typeof organization.id !== "string" ||
    !uuidPattern.test(organization.id) ||
    typeof organization.name !== "string" ||
    organization.name.trim().length < 1 ||
    organization.name.length > 200 ||
    typeof organization.role !== "string" ||
    !roles.has(organization.role)
  ) {
    throw new Error("invalid directory");
  }
  return {
    id: organization.id,
    name: organization.name.trim(),
    role: organization.role as OrganizationOption["role"],
  };
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function organizationNameFromUpdateEvent(event: Event): string | undefined {
  if (!(event instanceof CustomEvent)) return undefined;
  const detail: unknown = event.detail;
  if (!isRecord(detail)) return undefined;
  const name = detail["name"];
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 200 ||
    containsControlCharacter(name)
  ) {
    return undefined;
  }
  return name;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
