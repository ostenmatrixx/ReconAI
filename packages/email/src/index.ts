import { InvitationEmailSchema, RoleSchema } from "@workspace/domain";
import { z } from "zod";

const invitationUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      url.pathname === "/invitations/accept" &&
      /^#token=[A-Za-z0-9_-]{43}$/u.test(url.hash)
    );
  }, "invitation URL must contain only the bounded fragment token");

const invitationEmailInputSchema = z
  .object({
    invitationId: z.uuid(),
    recipientEmail: InvitationEmailSchema,
    role: RoleSchema,
    expiresAt: z.iso.datetime({ offset: true }),
    acceptUrl: invitationUrlSchema,
    correlationId: z.uuid(),
  })
  .strict();

const httpProviderOptionsSchema = z
  .object({
    endpoint: z.url().max(2048),
    authorizationToken: z.string().min(16).max(4096),
    from: z.email().max(320),
    timeoutMs: z.number().int().min(100).max(30_000),
  })
  .strict()
  .refine((options) => {
    const endpoint = new URL(options.endpoint);
    return !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash;
  }, "email relay endpoint cannot contain credentials, a query, or a fragment");

const providerMessageIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);

export interface InvitationEmailInput {
  readonly invitationId: string;
  readonly recipientEmail: string;
  readonly role: string;
  readonly expiresAt: string;
  readonly acceptUrl: string;
  readonly correlationId: string;
}

export type InvitationEmailDeliveryReceipt =
  | {
      readonly status: "accepted";
      readonly provider: "http_webhook";
      readonly providerMessageId?: string;
    }
  | {
      readonly status: "not_configured";
      readonly provider: "disabled";
    };

export interface InvitationEmailProvider {
  readonly name: "disabled" | "http_webhook";
  deliver(input: InvitationEmailInput): Promise<InvitationEmailDeliveryReceipt>;
}

export type InvitationEmailDeliveryErrorCode = "PROVIDER_UNAVAILABLE" | "PROVIDER_REJECTED";

export class InvitationEmailDeliveryError extends Error {
  public constructor(public readonly code: InvitationEmailDeliveryErrorCode) {
    super("invitation email delivery was not accepted");
    this.name = "InvitationEmailDeliveryError";
  }
}

export class DisabledInvitationEmailProvider implements InvitationEmailProvider {
  public readonly name = "disabled";

  public async deliver(input: InvitationEmailInput): Promise<InvitationEmailDeliveryReceipt> {
    invitationEmailInputSchema.parse(input);
    return { status: "not_configured", provider: this.name };
  }
}

type EmailFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HttpInvitationEmailProvider implements InvitationEmailProvider {
  public readonly name = "http_webhook";
  private readonly endpoint: URL;
  private readonly authorizationToken: string;
  private readonly from: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: EmailFetch;

  public constructor(
    options: {
      readonly endpoint: string;
      readonly authorizationToken: string;
      readonly from: string;
      readonly timeoutMs: number;
    },
    fetchImplementation: EmailFetch = fetch,
  ) {
    const parsed = httpProviderOptionsSchema.parse(options);
    this.endpoint = new URL(parsed.endpoint);
    this.authorizationToken = parsed.authorizationToken;
    this.from = parsed.from;
    this.timeoutMs = parsed.timeoutMs;
    this.fetchImplementation = fetchImplementation;
  }

  public async deliver(input: InvitationEmailInput): Promise<InvitationEmailDeliveryReceipt> {
    const parsed = invitationEmailInputSchema.parse(input);
    const message = buildInvitationMessage(this.from, parsed);
    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.authorizationToken}`,
          "content-type": "application/json",
          accept: "application/json",
          "x-request-id": parsed.correlationId,
        },
        body: JSON.stringify(message),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new InvitationEmailDeliveryError("PROVIDER_UNAVAILABLE");
    }

    const providerMessageId = providerMessageIdSchema.safeParse(
      response.headers.get("x-message-id"),
    );
    await response.body?.cancel();
    if (!response.ok) throw new InvitationEmailDeliveryError("PROVIDER_REJECTED");
    return {
      status: "accepted",
      provider: this.name,
      ...(providerMessageId.success ? { providerMessageId: providerMessageId.data } : {}),
    };
  }
}

function buildInvitationMessage(
  from: string,
  input: z.infer<typeof invitationEmailInputSchema>,
): Readonly<Record<string, unknown>> {
  const role = humanize(input.role);
  const subject = "You have been invited to ReconAI";
  const text = [
    `You have been invited to ReconAI as ${role}.`,
    `This single-use link expires at ${input.expiresAt}:`,
    input.acceptUrl,
    "Sign in with the exact provider-verified email address that received this message.",
  ].join("\n\n");
  const safeUrl = escapeHtml(input.acceptUrl);
  return {
    template: "organization_invitation_v1",
    from,
    to: input.recipientEmail,
    subject,
    text,
    html: [
      "<p>You have been invited to ReconAI as ",
      `<strong>${escapeHtml(role)}</strong>.</p>`,
      `<p><a href="${safeUrl}">Accept organization invitation</a></p>`,
      `<p>This single-use link expires at ${escapeHtml(input.expiresAt)}. `,
      "Sign in with the exact provider-verified email address that received this message.</p>",
    ].join(""),
    metadata: {
      invitationId: input.invitationId,
      correlationId: input.correlationId,
    },
  };
}

function humanize(value: string): string {
  const text = value.replaceAll("_", " ").toLocaleLowerCase("en-US");
  return text.charAt(0).toLocaleUpperCase("en-US") + text.slice(1);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
