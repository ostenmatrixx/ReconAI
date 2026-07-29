export class UpstreamBodyError extends Error {
  public constructor(public readonly code: "BODY_TOO_LARGE" | "INVALID_CONTENT_LENGTH") {
    super(code);
    this.name = "UpstreamBodyError";
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(declaredLength)) {
      throw new UpstreamBodyError("INVALID_CONTENT_LENGTH");
    }
    if (Number(declaredLength) > maximumBytes) {
      throw new UpstreamBodyError("BODY_TOO_LARGE");
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new UpstreamBodyError("BODY_TOO_LARGE");
      }
      chunks.push(chunk.value);
      chunk = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
