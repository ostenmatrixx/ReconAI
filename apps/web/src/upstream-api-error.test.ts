import { describe, expect, it } from "vitest";

import { readAllowlistedApiError, type ApiErrorPolicy } from "./upstream-api-error";

const correlationId = "00000000-0000-4000-8000-000000000090";
const policy = {
  RESOURCE_NOT_FOUND: {
    status: 404,
    message: "The requested resource is unavailable.",
  },
} as const satisfies ApiErrorPolicy;

describe("allowlisted internal API errors", () => {
  it("returns only the approved code, fixed message, and validated correlation identifier", async () => {
    const response = Response.json(
      {
        code: "RESOURCE_NOT_FOUND",
        message: "internal repository details that must not reach the browser",
        correlationId,
      },
      { status: 404 },
    );

    await expect(readAllowlistedApiError(response, policy)).resolves.toEqual({
      code: "RESOURCE_NOT_FOUND",
      message: "The requested resource is unavailable.",
      correlationId,
    });
  });

  it.each([
    {
      name: "an unapproved code",
      response: () =>
        Response.json(
          {
            code: "INTERNAL_ERROR",
            message: "internal details",
            correlationId,
          },
          { status: 500 },
        ),
    },
    {
      name: "a mismatched status",
      response: () =>
        Response.json(
          {
            code: "RESOURCE_NOT_FOUND",
            message: "internal details",
            correlationId,
          },
          { status: 409 },
        ),
    },
    {
      name: "an additional diagnostic field",
      response: () =>
        Response.json(
          {
            code: "RESOURCE_NOT_FOUND",
            message: "internal details",
            correlationId,
            accessToken: "must-not-cross-the-browser-boundary",
          },
          { status: 404 },
        ),
    },
    {
      name: "a malformed correlation identifier",
      response: () =>
        Response.json(
          {
            code: "RESOURCE_NOT_FOUND",
            message: "internal details",
            correlationId: "not-a-uuid",
          },
          { status: 404 },
        ),
    },
    {
      name: "a non-JSON response",
      response: () =>
        new Response("internal details", {
          status: 404,
          headers: { "content-type": "text/plain" },
        }),
    },
  ])("rejects $name", async ({ response }) => {
    await expect(readAllowlistedApiError(response(), policy)).rejects.toThrow();
  });

  it("rejects an oversized error before parsing it", async () => {
    const response = new Response("{}", {
      status: 404,
      headers: {
        "content-type": "application/json",
        "content-length": (64 * 1024 + 1).toString(),
      },
    });

    await expect(readAllowlistedApiError(response, policy)).rejects.toThrow("BODY_TOO_LARGE");
  });
});
