import { createHash } from "node:crypto";

import {
  StripeAppDeauthorizationEventSchema,
  constructStripeEvent,
} from "@workspace/connector-stripe";
import { z } from "zod";

import {
  PROVIDER_WEBHOOK_MAXIMUM_BYTES,
  ProviderWebhookAuthenticationError,
  ProviderWebhookValidationError,
} from "./provider-webhooks.js";

const stripeWebhookSecretSchema = z
  .string()
  .min(16)
  .max(512)
  .refine((value) => !/[\0\r\n]/u.test(value));

export interface StripeAppDeauthorizationRecord {
  readonly externalEventId: string;
  readonly externalAccountId: string;
  readonly payloadSha256: string;
  readonly livemode: boolean;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly correlationId: string;
}

export interface StripeAppDeauthorizationRepository {
  finalizeStripeDeauthorization(
    record: StripeAppDeauthorizationRecord,
  ): Promise<{ readonly matched: boolean; readonly duplicate: boolean }>;
}

export interface StripeAppDeauthorizationResult {
  readonly eventId: string;
  readonly status: "accepted";
  readonly duplicate: boolean;
}

/**
 * Authenticates the app-level Stripe uninstall signal against the untouched raw body before
 * delegating tenant resolution and idempotent local cleanup to the repository.
 */
export class StripeAppDeauthorizationService {
  readonly #endpointSecret: string;
  readonly #now: () => Date;

  public constructor(
    private readonly repository: StripeAppDeauthorizationRepository,
    endpointSecretInput: string,
    now: () => Date = () => new Date(),
  ) {
    this.#endpointSecret = stripeWebhookSecretSchema.parse(endpointSecretInput);
    this.#now = now;
  }

  public async receive(input: {
    readonly rawBody: Uint8Array;
    readonly signature: string;
    readonly correlationId: string;
  }): Promise<StripeAppDeauthorizationResult> {
    const rawBody = parseRawBody(input.rawBody);
    const signature = z.string().min(1).max(2048).parse(input.signature);
    const correlationId = z.uuid().parse(input.correlationId);
    let authenticatedEvent;
    try {
      authenticatedEvent = constructStripeEvent(rawBody, signature, this.#endpointSecret);
    } catch {
      throw new ProviderWebhookAuthenticationError();
    }
    const event = StripeAppDeauthorizationEventSchema.safeParse(authenticatedEvent);
    if (!event.success) {
      throw new ProviderWebhookValidationError(
        "Stripe app webhook is not a supported deauthorization event",
      );
    }
    const result = await this.repository.finalizeStripeDeauthorization({
      externalEventId: event.data.id,
      externalAccountId: event.data.account,
      payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
      livemode: event.data.livemode,
      occurredAt: new Date(event.data.created * 1000).toISOString(),
      receivedAt: this.#now().toISOString(),
      correlationId,
    });
    return {
      eventId: event.data.id,
      status: "accepted",
      duplicate: result.duplicate,
    };
  }
}

function parseRawBody(value: Uint8Array): Uint8Array {
  if (value.byteLength < 1 || value.byteLength > PROVIDER_WEBHOOK_MAXIMUM_BYTES) {
    throw new ProviderWebhookValidationError("Stripe app webhook body is outside the byte limit");
  }
  return value;
}
