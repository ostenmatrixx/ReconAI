import { describe, expect, it } from "vitest";

import { readBoundedResponseBytes } from "./bounded-response";

describe("bounded upstream response reader", () => {
  it("returns a fully prepared non-empty payload within the limit", async () => {
    const response = new Response("exception export", {
      headers: { "content-length": "16" },
    });

    const bytes = await readBoundedResponseBytes(response, 64);

    expect(new TextDecoder().decode(bytes)).toBe("exception export");
    expect(bytes.byteLength).toBe(16);
  });

  it("rejects an oversized declared response before reading it", async () => {
    const response = new Response("small", {
      headers: { "content-length": "1000" },
    });

    await expect(readBoundedResponseBytes(response, 64)).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
    });
  });

  it("cancels an oversized chunked response", async () => {
    const response = new Response("x".repeat(65));

    await expect(readBoundedResponseBytes(response, 64)).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
    });
  });
});
