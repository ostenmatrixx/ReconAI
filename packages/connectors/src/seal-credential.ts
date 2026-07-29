import {
  ConnectorCredentialPurposeSchema,
  createConnectorCredentialKeyring,
  sealConnectorCredential,
} from "./index.js";
import { OrganizationIdSchema } from "@workspace/domain";
import { z } from "zod";

const argumentsSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    connectionId: z.uuid(),
    provider: z.enum(["shopify", "stripe"]),
    purpose: ConnectorCredentialPurposeSchema,
  })
  .strict();

if (process.stdin.isTTY) {
  throw new Error(
    "credential sealing requires the secret on standard input; command arguments are not accepted",
  );
}

const values = new Map<string, string>();
const allowedFlags = new Set(["organization-id", "connection-id", "provider", "purpose"]);
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
    throw new Error("credential sealing arguments must be --name value pairs");
  }
  const name = flag.slice(2);
  if (!allowedFlags.has(name) || values.has(name)) {
    throw new Error(`unsupported or duplicate credential sealing argument: --${name}`);
  }
  values.set(name, value);
}
const context = argumentsSchema.parse({
  organizationId: values.get("organization-id"),
  connectionId: values.get("connection-id"),
  provider: values.get("provider"),
  purpose: values.get("purpose"),
});
const references = process.env["CONNECTOR_ENCRYPTION_KEYS"];
const activeVersion = process.env["CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION"];
if (!references || !activeVersion) {
  throw new Error("connector encryption key configuration is required");
}

let secret = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  if (typeof chunk !== "string") throw new Error("credential input must be UTF-8 text");
  secret += chunk;
}
secret = secret.replace(/\r?\n$/u, "");
const keyring = createConnectorCredentialKeyring({
  references,
  activeVersion,
  environment: process.env,
  production: process.env["NODE_ENV"] === "production",
});
const envelope = sealConnectorCredential({ ...context, secret }, keyring);
process.stdout.write(`${JSON.stringify(envelope)}\n`);
