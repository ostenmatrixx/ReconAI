import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  providerWebhookIngressSurfaceFor,
  requireRouteSecurityContract,
  routeSecurityContractFor,
  routeSecurityContracts,
} from "./route-security.js";

describe("API route security contract", () => {
  it("classifies every registered application route exactly once", () => {
    const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    const registeredRoutes = [
      ...source.matchAll(/(?:app|routes)\.(get|post|patch|put|delete)\(\s*["']([^"']+)/gu),
    ].map((match) => `${String(match[1]).toUpperCase()} ${String(match[2])}`);
    const contractedRoutes = routeSecurityContracts.map(
      (contract) => `${contract.method} ${contract.path}`,
    );

    expect(new Set(registeredRoutes).size).toBe(registeredRoutes.length);
    expect(new Set(contractedRoutes).size).toBe(contractedRoutes.length);
    expect([...contractedRoutes].sort()).toEqual([...registeredRoutes].sort());
    expect(contractedRoutes).toHaveLength(55);
  });

  it("keeps public, identity, support, provider-signature, and tenant boundaries explicit", () => {
    for (const contract of routeSecurityContracts) {
      expect(contract.stateChanging).toBe(contract.method !== "GET");
      if (contract.authentication === "public_health") {
        expect(contract.path).toMatch(/^\/health\/(?:live|ready)$/u);
      } else if (contract.authentication === "identity") {
        expect(contract.path).toMatch(/^\/v1\/(?:organizations|invitations\/accept)$/u);
      } else if (contract.authentication === "support") {
        expect(contract.path).toMatch(/^\/v1\/support\//u);
      } else if (contract.authentication === "provider_signature") {
        expect(contract.path).toMatch(/^\/v1\/webhooks\//u);
        expect(contract.verifier).toMatch(
          /^(?:shopify|stripe)_(?:app|connection)_(?:hmac|signature)$/u,
        );
      } else {
        expect(contract.path).toContain("/v1/organizations/:organizationId");
        expect(contract.permissions.length).toBeGreaterThan(0);
        expect(new Set(contract.permissions).size).toBe(contract.permissions.length);
      }
    }
  });

  it("keeps tenant manifest permissions equal to handler-level checks", () => {
    const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    const sourceFile = ts.createSourceFile(
      "app.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const handlers = routeHandlers(sourceFile);

    for (const contract of routeSecurityContracts) {
      const key = `${contract.method} ${contract.path}`;
      const handler = handlers.get(key);
      expect(handler, `missing handler for ${key}`).toBeDefined();
      const handlerPermissions = handler ? permissionChecks(handler) : [];
      if (contract.authentication === "tenant") {
        expect([...handlerPermissions].sort(), key).toEqual([...contract.permissions].sort());
      } else {
        expect(handlerPermissions, key).toEqual([]);
      }
    }
  });

  it("supports generated HEAD routes but rejects unclassified methods and paths", () => {
    expect(routeSecurityContractFor("HEAD", "/health/live")).toMatchObject({
      method: "GET",
      authentication: "public_health",
    });
    expect(() =>
      requireRouteSecurityContract(
        "DELETE",
        "/v1/organizations/:organizationId/exceptions/:exceptionId",
      ),
    ).toThrow(/no security contract/u);
    expect(() => requireRouteSecurityContract("GET", "/v1/unclassified")).toThrow(
      /no security contract/u,
    );
  });

  it("maps only the four provider-signature contracts to fixed telemetry surfaces", () => {
    const surfaces = routeSecurityContracts.flatMap((contract) => {
      const surface = providerWebhookIngressSurfaceFor(contract.method, contract.path);
      if (contract.authentication === "provider_signature") {
        expect(surface).toBeDefined();
      } else {
        expect(surface).toBeUndefined();
      }
      return surface ? [surface] : [];
    });
    expect(surfaces.sort()).toEqual([
      "shopify_connection",
      "shopify_privacy",
      "stripe_connection",
      "stripe_deauthorization",
    ]);
  });
});

function routeHandlers(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Node> {
  const handlers = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.expression.getText(sourceFile) === "app" ||
        node.expression.expression.getText(sourceFile) === "routes") &&
      ["get", "post", "patch", "put", "delete"].includes(node.expression.name.text)
    ) {
      const pathArgument = node.arguments[0];
      const handler = node.arguments.at(-1);
      if (pathArgument && ts.isStringLiteral(pathArgument) && handler) {
        const key = `${node.expression.name.text.toUpperCase()} ${pathArgument.text}`;
        handlers.set(key, handler);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return handlers;
}

function permissionChecks(handler: ts.Node): readonly string[] {
  const permissions: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const permissionIndex =
        node.expression.text === "authorizeRequest"
          ? 2
          : node.expression.text === "requirePermission"
            ? 1
            : undefined;
      if (permissionIndex !== undefined) {
        const permission = node.arguments[permissionIndex];
        if (permission && ts.isStringLiteral(permission)) permissions.push(permission.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(handler);
  return permissions;
}
