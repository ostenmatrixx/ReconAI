import { describe, expect, it } from "vitest";

import { readBoundedJson } from "./bounded-json";

describe("bounded JSON reader", () => {
  it("parses a bounded JSON request", async () => {
    const request = new Request("https://app.example.test/api/action", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ action: "test" }),
    });

    await expect(readBoundedJson(request)).resolves.toEqual({ action: "test" });
  });

  it("rejects an oversized declared body before reading it", async () => {
    const request = new Request("https://app.example.test/api/action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "20000",
      },
      body: "{}",
    });

    await expect(readBoundedJson(request)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
  });

  it("stops an oversized chunked body", async () => {
    const request = new Request("https://app.example.test/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(17_000) }),
    });

    await expect(readBoundedJson(request)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
  });
});
