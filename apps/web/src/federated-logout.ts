import { createHash, timingSafeEqual } from "node:crypto";

const maximumLogoutFormBytes = 4 * 1024;
const maximumIdTokenLength = 32_768;
const csrfTokenPattern = /^[0-9a-f]{64}$/;

export interface ProviderLogoutConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly applicationOrigin: string;
}

export function buildProviderLogoutUrl(
  configuration: ProviderLogoutConfiguration,
  idToken: string,
): URL {
  if (idToken.length === 0 || idToken.length > maximumIdTokenLength) {
    throw new Error("ID token is outside the permitted bounds");
  }

  const issuer = validatedHttpUrl(configuration.issuer, false);
  const applicationOrigin = validatedHttpUrl(configuration.applicationOrigin, true);
  const logoutUrl = new URL(
    "protocol/openid-connect/logout",
    issuer.toString().endsWith("/") ? issuer : `${issuer.toString()}/`,
  );
  logoutUrl.searchParams.set("client_id", configuration.clientId);
  logoutUrl.searchParams.set("id_token_hint", idToken);
  logoutUrl.searchParams.set(
    "post_logout_redirect_uri",
    new URL("/", applicationOrigin).toString(),
  );
  return logoutUrl;
}

export function verifyNextAuthCsrfToken(
  cookieValue: string | undefined,
  bodyValue: string | undefined,
  secret: string,
): boolean {
  if (!cookieValue || !bodyValue || !csrfTokenPattern.test(bodyValue)) return false;

  const decodedCookie = decodeCookieValue(cookieValue);
  if (!decodedCookie) return false;
  const parts = decodedCookie.split("|");
  if (parts.length !== 2) return false;

  const [cookieToken, cookieHash] = parts;
  if (
    !cookieToken ||
    !cookieHash ||
    !csrfTokenPattern.test(cookieToken) ||
    !csrfTokenPattern.test(cookieHash)
  ) {
    return false;
  }

  const expectedHash = createHash("sha256").update(`${cookieToken}${secret}`).digest("hex");
  return safeEqual(cookieHash, expectedHash) && safeEqual(cookieToken, bodyValue);
}

export function sessionCookieNamesToClear(
  requestCookieNames: readonly string[],
  sessionCookieName: string,
): string[] {
  const chunkPattern = new RegExp(`^${escapeRegExp(sessionCookieName)}\\.\\d+$`);
  return [
    sessionCookieName,
    ...requestCookieNames.filter((name) => chunkPattern.test(name)),
  ].filter((name, index, names) => names.indexOf(name) === index);
}

export async function readLogoutCsrfToken(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return undefined;

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumLogoutFormBytes
    ) {
      return undefined;
    }
  }

  const bytes = await readBoundedBody(request, maximumLogoutFormBytes);
  if (!bytes) return undefined;

  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }

  const parameters = new URLSearchParams(body);
  const keys = [...parameters.keys()];
  if (keys.length !== 1 || keys[0] !== "csrfToken") return undefined;

  const values = parameters.getAll("csrfToken");
  if (values.length !== 1 || !csrfTokenPattern.test(values[0] ?? "")) return undefined;
  return values[0];
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const result = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeCookieValue(value: string): string | null {
  if (value.includes("|")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validatedHttpUrl(value: string, requireOrigin: boolean): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (requireOrigin && url.pathname !== "/")
  ) {
    throw new Error("Logout URL configuration is invalid");
  }
  return url;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
