import { describe, expect, it, vi } from "vitest";

import {
  DisabledInvitationEmailProvider,
  HttpInvitationEmailProvider,
  InvitationEmailDeliveryError,
  type InvitationEmailInput,
} from "./index.js";

const input: InvitationEmailInput = {
  invitationId: "00000000-0000-4000-8000-000000000030",
  recipientEmail: "reviewer@example.test",
  role: "reviewer",
  expiresAt: "2026-07-30T12:00:00.000Z",
  acceptUrl: `https://app.example.test/invitations/accept#token=${"b".repeat(43)}`,
  correlationId: "00000000-0000-4000-8000-000000000031",
};

describe("invitation email delivery", () => {
  it("returns an explicit disabled receipt without persisting the bearer", async () => {
    const provider = new DisabledInvitationEmailProvider();

    await expect(provider.deliver(input)).resolves.toEqual({
      status: "not_configured",
      provider: "disabled",
    });
  });

  it("submits a bounded invitation message without allowing provider redirects", async () => {
    const fetchImplementation = vi.fn(
      async (_request: string | URL | Request, _init?: RequestInit) =>
        new Response(null, {
          status: 202,
          headers: { "x-message-id": "message-123" },
        }),
    );
    const provider = new HttpInvitationEmailProvider(
      {
        endpoint: "https://email-relay.example.test/v1/messages",
        authorizationToken: "synthetic-email-relay-token",
        from: "access@example.test",
        timeoutMs: 2_000,
      },
      fetchImplementation,
    );

    await expect(provider.deliver(input)).resolves.toEqual({
      status: "accepted",
      provider: "http_webhook",
      providerMessageId: "message-123",
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const call = fetchImplementation.mock.calls[0];
    if (!call) throw new Error("expected an email relay request");
    expect(call[0]).toEqual(new URL("https://email-relay.example.test/v1/messages"));
    expect(call[1]).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: {
        authorization: "Bearer synthetic-email-relay-token",
        "content-type": "application/json",
        accept: "application/json",
        "x-request-id": input.correlationId,
      },
    });
    expect(call[1]?.body).toBe(
      JSON.stringify({
        template: "organization_invitation_v1",
        from: "access@example.test",
        to: input.recipientEmail,
        subject: "You have been invited to ReconAI",
        text: [
          "You have been invited to ReconAI as Reviewer.",
          `This single-use link expires at ${input.expiresAt}:`,
          input.acceptUrl,
          "Sign in with the exact provider-verified email address that received this message.",
        ].join("\n\n"),
        html: [
          "<p>You have been invited to ReconAI as ",
          "<strong>Reviewer</strong>.</p>",
          `<p><a href="${input.acceptUrl}">Accept organization invitation</a></p>`,
          `<p>This single-use link expires at ${input.expiresAt}. `,
          "Sign in with the exact provider-verified email address that received this message.</p>",
        ].join(""),
        metadata: {
          invitationId: input.invitationId,
          correlationId: input.correlationId,
        },
      }),
    );
  });

  it("returns only a stable safe error code when the relay rejects delivery", async () => {
    const provider = new HttpInvitationEmailProvider(
      {
        endpoint: "https://email-relay.example.test/v1/messages",
        authorizationToken: "synthetic-email-relay-token",
        from: "access@example.test",
        timeoutMs: 2_000,
      },
      async () => new Response("provider detail must not escape", { status: 503 }),
    );

    const failure = await provider.deliver(input).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InvitationEmailDeliveryError);
    expect(failure).toMatchObject({ code: "PROVIDER_REJECTED" });
    expect(String(failure)).not.toContain(input.acceptUrl);
    expect(String(failure)).not.toContain("provider detail");
    expect(String(failure)).not.toContain("synthetic-email-relay-token");
  });
});
