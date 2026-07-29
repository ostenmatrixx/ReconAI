import {
  ConnectorError,
  ProviderSyncJobEnvelopeSchema,
  type ProviderPage,
  type ProviderPageSource,
  type ProviderSyncJobEnvelope,
  type ProviderSyncMode,
} from "@workspace/connectors";
import { type OrganizationId, type TenantContext } from "@workspace/domain";
import { z } from "zod";

import {
  ProviderWebhookConflictError,
  ProviderWebhookValidationError,
  type ProviderName,
  type ProviderWebhookResult,
} from "./provider-webhooks.js";

export interface ProviderSyncRunAuthority {
  readonly runId: string;
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly provider: ProviderName;
  readonly externalAccountId: string;
  readonly apiCredentialReference: string;
  readonly configuredApiVersion?: string;
  readonly mode: ProviderSyncMode;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly cursor?: string;
  readonly status: "queued" | "running" | "partial" | "succeeded" | "failed";
  readonly pageCount: number;
  readonly itemCount: number;
  readonly duplicateCount: number;
  readonly maximumPages: number;
  readonly failedAttempts: number;
  readonly requesterType: "user" | "system";
  readonly requestedBy: string;
  readonly correlationId: string;
}

export interface ProviderSyncRun {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly provider: ProviderName;
  readonly mode: ProviderSyncMode;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly status: "queued" | "running" | "partial" | "succeeded" | "failed";
  readonly pageCount: number;
  readonly itemCount: number;
  readonly duplicateCount: number;
  readonly maximumPages: number;
  readonly failedAttempts: number;
  readonly requesterType: "user" | "system";
  readonly lastErrorCode?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
}

export interface ProviderSyncStartInput {
  readonly connectionId: string;
  readonly mode: ProviderSyncMode;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly maximumPages: number;
  readonly reason: string;
  readonly correlationId: string;
  readonly traceparent?: string;
}

export interface ProviderSyncManager {
  start(tenant: TenantContext, input: ProviderSyncStartInput): Promise<ProviderSyncRun>;
  list(tenant: TenantContext, connectionId?: string): Promise<readonly ProviderSyncRun[]>;
}

export interface ProviderSyncRepository {
  loadForProcessing(
    envelope: ProviderSyncJobEnvelope,
  ): Promise<ProviderSyncRunAuthority | undefined>;
  advancePage(
    envelope: ProviderSyncJobEnvelope,
    input: {
      readonly expectedCursor?: string;
      readonly nextCursor?: string;
      readonly hasMore: boolean;
      readonly itemCount: number;
      readonly duplicateCount: number;
      readonly completedAt: string;
    },
  ): Promise<ProviderSyncRunAuthority>;
  recordFailure(
    envelope: ProviderSyncJobEnvelope,
    input: {
      readonly errorCode: string;
      readonly terminalRequested: boolean;
      readonly failedAt: string;
    },
  ): Promise<{ readonly terminal: boolean }>;
}

export interface ProviderSyncServiceOptions {
  readonly repository: ProviderSyncRepository;
  readonly providerEvents: ProviderSyncEventReceiver;
  readonly sources: readonly ProviderPageSource[];
  readonly requestCircuit: ProviderRequestCircuit;
  readonly now?: () => Date;
}

export interface ProviderSyncEventReceiver {
  receiveSyncItem(input: {
    readonly organizationId: string;
    readonly connectionId: string;
    readonly provider: ProviderName;
    readonly eventType: string;
    readonly externalEventId: string;
    readonly externalObjectId: string;
    readonly sourceTimestamp: string;
    readonly apiVersion?: string;
    readonly rawBody: Uint8Array;
    readonly correlationId: string;
    readonly traceparent?: string;
  }): Promise<ProviderWebhookResult>;
}

export interface ProviderSyncProcessContext {
  readonly traceparent?: string;
}

export interface ProviderRequestCircuitInput {
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly provider: ProviderName;
}

export interface ProviderRequestCircuitPermit {
  readonly state: "closed" | "half_open";
  readonly token: string;
}

export type ProviderRequestCircuitAcquireResult =
  | {
      readonly outcome: "permitted";
      readonly permit: ProviderRequestCircuitPermit;
    }
  | {
      readonly outcome: "open";
      readonly retryAfterMs: number;
    };

export interface ProviderRequestCircuit {
  acquire(input: ProviderRequestCircuitInput): Promise<ProviderRequestCircuitAcquireResult>;
  recordSuccess(
    input: ProviderRequestCircuitInput & {
      readonly permit: ProviderRequestCircuitPermit;
    },
  ): Promise<void>;
  recordTransientFailure(
    input: ProviderRequestCircuitInput & {
      readonly permit: ProviderRequestCircuitPermit;
      readonly forceOpen: boolean;
      readonly retryAfterMs?: number;
    },
  ): Promise<void>;
}

export interface ProviderSyncProcessResult {
  readonly status: "already_processed" | "partial" | "succeeded";
  readonly pagesProcessed: number;
  readonly itemsStaged: number;
  readonly duplicates: number;
}

export class ProviderSyncTerminalError extends Error {
  public constructor(public readonly code: string) {
    super("provider sync cannot be retried");
    this.name = "ProviderSyncTerminalError";
  }
}

export class ProviderSyncService {
  readonly #now: () => Date;
  readonly #sources: ReadonlyMap<ProviderName, ProviderPageSource>;

  public constructor(private readonly options: ProviderSyncServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    const entries = options.sources.map((source) => [source.provider, source] as const);
    this.#sources = new Map(entries);
    if (this.#sources.size !== entries.length) {
      throw new TypeError("provider sync sources must be unique by provider");
    }
  }

  public async process(
    envelopeInput: ProviderSyncJobEnvelope,
    context: ProviderSyncProcessContext = {},
  ): Promise<ProviderSyncProcessResult> {
    const envelope = ProviderSyncJobEnvelopeSchema.parse(envelopeInput);
    let run = await this.options.repository.loadForProcessing(envelope);
    if (!run) throw new ProviderSyncTerminalError("PROVIDER_SYNC_NOT_FOUND");
    assertSyncAuthority(run, envelope);
    if (run.status === "succeeded" || run.status === "partial") {
      return {
        status: "already_processed",
        pagesProcessed: 0,
        itemsStaged: 0,
        duplicates: 0,
      };
    }
    if (run.status === "failed") {
      throw new ProviderSyncTerminalError("PROVIDER_SYNC_ALREADY_FAILED");
    }
    const source = this.#sources.get(run.provider);
    if (!source) {
      await this.options.repository.recordFailure(envelope, {
        errorCode: "PROVIDER_SYNC_SOURCE_UNAVAILABLE",
        terminalRequested: true,
        failedAt: this.#now().toISOString(),
      });
      throw new ProviderSyncTerminalError("PROVIDER_SYNC_SOURCE_UNAVAILABLE");
    }

    let pagesProcessed = 0;
    let itemsStaged = 0;
    let duplicates = 0;
    try {
      while (run.status === "running" || run.status === "queued") {
        const circuitInput = {
          organizationId: run.organizationId,
          connectionId: run.connectionId,
          provider: run.provider,
        } satisfies ProviderRequestCircuitInput;
        const acquired = await this.options.requestCircuit.acquire(circuitInput);
        if (acquired.outcome === "open") {
          throw new ConnectorError(
            "provider_unavailable",
            "provider request circuit is open",
            acquired.retryAfterMs,
          );
        }
        let page: ProviderPage;
        try {
          page = validatePage(
            await source.fetchPage({
              organizationId: run.organizationId,
              connectionId: run.connectionId,
              provider: run.provider,
              externalAccountId: run.externalAccountId,
              apiCredentialReference: run.apiCredentialReference,
              ...(run.configuredApiVersion
                ? { configuredApiVersion: run.configuredApiVersion }
                : {}),
              mode: run.mode,
              windowStart: run.windowStart,
              windowEnd: run.windowEnd,
              ...(run.cursor ? { cursor: run.cursor } : {}),
              limit: 100,
            }),
            run.cursor,
          );
        } catch (error) {
          if (isCircuitTransientFailure(error)) {
            await this.options.requestCircuit.recordTransientFailure({
              ...circuitInput,
              permit: acquired.permit,
              forceOpen: error.kind === "rate_limited",
              ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
            });
          } else {
            // Authentication, authorization, payload, and local validation failures are not
            // provider-availability failures. Releasing the probe prevents a stuck half-open lease.
            await this.options.requestCircuit.recordSuccess({
              ...circuitInput,
              permit: acquired.permit,
            });
          }
          throw error;
        }
        await this.options.requestCircuit.recordSuccess({
          ...circuitInput,
          permit: acquired.permit,
        });
        let pageDuplicates = 0;
        for (const item of page.items) {
          const result = await this.options.providerEvents.receiveSyncItem({
            organizationId: run.organizationId,
            connectionId: run.connectionId,
            provider: run.provider,
            eventType: item.eventType,
            externalEventId: item.externalEventId,
            externalObjectId: item.externalObjectId,
            sourceTimestamp: item.sourceTimestamp,
            ...(item.apiVersion ? { apiVersion: item.apiVersion } : {}),
            rawBody: item.rawBody,
            correlationId: run.correlationId,
            ...(context.traceparent ? { traceparent: context.traceparent } : {}),
          });
          if (result.duplicate) pageDuplicates += 1;
        }
        const completedAt = this.#now().toISOString();
        run = await this.options.repository.advancePage(envelope, {
          ...(run.cursor ? { expectedCursor: run.cursor } : {}),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          hasMore: page.hasMore,
          itemCount: page.items.length,
          duplicateCount: pageDuplicates,
          completedAt,
        });
        pagesProcessed += 1;
        itemsStaged += page.items.length;
        duplicates += pageDuplicates;
      }
    } catch (error) {
      if (error instanceof ProviderSyncTerminalError) throw error;
      const failure = classifySyncFailure(error);
      const recorded = await this.options.repository.recordFailure(envelope, {
        errorCode: failure.errorCode,
        terminalRequested: failure.terminal,
        failedAt: this.#now().toISOString(),
      });
      if (recorded.terminal) throw new ProviderSyncTerminalError(failure.errorCode);
      throw error;
    }

    return {
      status: run.status === "partial" ? "partial" : "succeeded",
      pagesProcessed,
      itemsStaged,
      duplicates,
    };
  }
}

function assertSyncAuthority(
  run: ProviderSyncRunAuthority,
  envelope: ProviderSyncJobEnvelope,
): void {
  if (
    run.runId !== envelope.syncRunId ||
    run.organizationId !== envelope.organizationId ||
    run.connectionId !== envelope.connectionId ||
    run.provider !== envelope.provider ||
    run.requestedBy !== envelope.requestedBy ||
    run.correlationId !== envelope.correlationId ||
    envelope.idempotencyKey !==
      `${run.provider}:sync:${run.runId}:dispatch:${String(envelope.executionAttempt)}`
  ) {
    throw new ProviderSyncTerminalError("PROVIDER_SYNC_AUTHORITY_MISMATCH");
  }
}

function validatePage(page: ProviderPage, currentCursor: string | undefined): ProviderPage {
  if (page.items.length > 100) {
    throw new ConnectorError("invalid_payload", "provider sync page exceeds the item limit");
  }
  const sourcePhaseTransition = page.continuationKind === "source_phase";
  if (page.hasMore) {
    if (
      (page.items.length === 0 && !sourcePhaseTransition) ||
      !page.nextCursor ||
      page.nextCursor === currentCursor ||
      page.nextCursor.length > 1024
    ) {
      throw new ConnectorError("invalid_payload", "provider sync cursor did not advance");
    }
  } else if (page.nextCursor || sourcePhaseTransition) {
    throw new ConnectorError(
      "invalid_payload",
      "terminal provider sync page returned continuation state",
    );
  }
  for (const item of page.items) {
    z.string()
      .regex(/^[a-z0-9._/-]{1,100}$/u)
      .parse(item.eventType);
    z.string()
      .regex(/^[A-Za-z0-9._:/-]{1,255}$/u)
      .parse(item.externalEventId);
    z.string().min(1).max(255).parse(item.externalObjectId);
    z.iso.datetime({ offset: true }).parse(item.sourceTimestamp);
    if (item.apiVersion) z.string().min(1).max(50).parse(item.apiVersion);
    if (item.rawBody.byteLength < 1 || item.rawBody.byteLength > 1024 * 1024) {
      throw new ConnectorError("invalid_payload", "provider sync item exceeds the byte limit");
    }
  }
  return page;
}

function classifySyncFailure(error: unknown): {
  readonly errorCode: string;
  readonly terminal: boolean;
} {
  if (error instanceof ConnectorError) {
    const codeByKind = {
      authentication: "PROVIDER_SYNC_AUTHENTICATION_FAILED",
      authorization: "PROVIDER_SYNC_AUTHORIZATION_FAILED",
      rate_limited: "PROVIDER_SYNC_RATE_LIMITED",
      timeout: "PROVIDER_SYNC_TIMEOUT",
      invalid_payload: "PROVIDER_SYNC_PAYLOAD_INVALID",
      provider_unavailable: "PROVIDER_SYNC_UNAVAILABLE",
      terminal: "PROVIDER_SYNC_REQUEST_INVALID",
    } as const;
    return {
      errorCode: codeByKind[error.kind],
      terminal: ["authentication", "authorization", "invalid_payload", "terminal"].includes(
        error.kind,
      ),
    };
  }
  if (
    error instanceof ProviderWebhookConflictError ||
    error instanceof ProviderWebhookValidationError ||
    error instanceof z.ZodError
  ) {
    return { errorCode: "PROVIDER_SYNC_ITEM_INVALID", terminal: true };
  }
  return { errorCode: "PROVIDER_SYNC_FAILED", terminal: false };
}

function isCircuitTransientFailure(error: unknown): error is ConnectorError & {
  readonly kind: "rate_limited" | "timeout" | "provider_unavailable";
} {
  return (
    error instanceof ConnectorError &&
    ["rate_limited", "timeout", "provider_unavailable"].includes(error.kind)
  );
}
