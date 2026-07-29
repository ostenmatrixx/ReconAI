import { describe, expect, it } from "vitest";

import { FormBodyError, readBoundedUrlEncodedForm } from "./bounded-form";

describe("bounded URL-encoded form reader", () => {
  it("reads a bounded form without normalizing duplicate fields", async () => {
    const body = "provider=stripe&state=one&state=two";
    const form = await readBoundedUrlEncodedForm(
      new Request("https://web.example.test/start", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );
    expect(form.getAll("state")).toEqual(["one", "two"]);
  });

  it("rejects unsupported and oversized bodies", async () => {
    await expect(
      readBoundedUrlEncodedForm(
        new Request("https://web.example.test/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ),
    ).rejects.toBeInstanceOf(FormBodyError);
    await expect(
      readBoundedUrlEncodedForm(
        new Request("https://web.example.test/start", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": "4096",
          },
          body: "provider=stripe",
        }),
      ),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
  });
});
