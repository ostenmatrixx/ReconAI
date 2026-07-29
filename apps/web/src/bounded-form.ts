export class FormBodyError extends Error {
  public constructor(
    public readonly code: "INVALID_FORM" | "UNSUPPORTED_MEDIA_TYPE" | "PAYLOAD_TOO_LARGE",
    public readonly status: 400 | 413 | 415,
  ) {
    super(code);
    this.name = "FormBodyError";
  }
}

export async function readBoundedUrlEncodedForm(
  request: Pick<Request, "body" | "headers">,
  maximumBytes = 2048,
): Promise<URLSearchParams> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    throw new FormBodyError("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    if (!/^\d{1,12}$/u.test(contentLength)) throw new FormBodyError("INVALID_FORM", 400);
    if (Number(contentLength) > maximumBytes) {
      throw new FormBodyError("PAYLOAD_TOO_LARGE", 413);
    }
  }
  if (!request.body) throw new FormBodyError("INVALID_FORM", 400);

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw new FormBodyError("PAYLOAD_TOO_LARGE", 413);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return new URLSearchParams(body);
  } catch (error) {
    if (error instanceof FormBodyError) throw error;
    throw new FormBodyError("INVALID_FORM", 400);
  } finally {
    reader.releaseLock();
  }
}
