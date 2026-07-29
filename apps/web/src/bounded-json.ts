export class RequestBodyError extends Error {
  public constructor(
    public readonly code: "INVALID_JSON" | "UNSUPPORTED_MEDIA_TYPE" | "PAYLOAD_TOO_LARGE",
    public readonly status: 400 | 413 | 415,
  ) {
    super(code);
    this.name = "RequestBodyError";
  }
}

export async function readBoundedJson(
  request: Pick<Request, "body" | "headers">,
  maximumBytes = 16 * 1024,
): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new RequestBodyError("UNSUPPORTED_MEDIA_TYPE", 415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    if (!/^\d{1,12}$/u.test(contentLength)) {
      throw new RequestBodyError("INVALID_JSON", 400);
    }
    if (Number(contentLength) > maximumBytes) {
      throw new RequestBodyError("PAYLOAD_TOO_LARGE", 413);
    }
  }

  if (!request.body) throw new RequestBodyError("INVALID_JSON", 400);
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
        throw new RequestBodyError("PAYLOAD_TOO_LARGE", 413);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("INVALID_JSON", 400);
  } finally {
    reader.releaseLock();
  }
}
