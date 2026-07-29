import { describe, expect, it } from "vitest";

import {
  continuousIntegrationSecurityBoundaryErrors,
  containerInstallBoundaryErrors,
  containerRuntimeToolchainBoundaryErrors,
  nodeActiveLtsSecurityPatchError,
  redisSecurityPatchError,
  releaseCandidateScannerBoundaryErrors,
  serviceRuntimeParserBoundaryErrors,
} from "./container-integrity-policy.mjs";

describe("container integrity policy", () => {
  it("rejects Redis security regressions and floating tags", () => {
    expect(redisSecurityPatchError("8.2.1-alpine")).toMatch(/must not regress/u);
    expect(redisSecurityPatchError("8.2.7-alpine")).toMatch(/must not regress/u);
    expect(redisSecurityPatchError("7.4.10-alpine")).toMatch(/must not regress/u);
    expect(redisSecurityPatchError("latest")).toMatch(/explicit semantic/u);
  });

  it("accepts the reviewed Redis patch and later semantic releases", () => {
    expect(redisSecurityPatchError("8.2.8-alpine")).toBeUndefined();
    expect(redisSecurityPatchError("8.4.3-alpine")).toBeUndefined();
    expect(redisSecurityPatchError("9.0.0-alpine")).toBeUndefined();
  });

  it("rejects stale or ambiguous Node runtime bases", () => {
    expect(nodeActiveLtsSecurityPatchError("24.14.0-bookworm-slim")).toMatch(/must not regress/u);
    expect(nodeActiveLtsSecurityPatchError("24-bookworm-slim")).toMatch(/explicit/u);
    expect(nodeActiveLtsSecurityPatchError("26.3.1-bookworm-slim")).toMatch(/Node 24 Active LTS/u);
  });

  it("accepts the reviewed Node Active LTS patch and later patches on the same line", () => {
    expect(nodeActiveLtsSecurityPatchError("24.18.0-bookworm-slim")).toBeUndefined();
    expect(nodeActiveLtsSecurityPatchError("24.18.1-bookworm-slim")).toBeUndefined();
    expect(nodeActiveLtsSecurityPatchError("24.19.0-bookworm-slim")).toBeUndefined();
  });

  it("requires exact removal of the build-only package-manager runtime toolchain", () => {
    expect(
      containerRuntimeToolchainBoundaryErrors(
        "RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack && " +
          "rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack " +
          "/usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg",
      ),
    ).toEqual([]);
    expect(containerRuntimeToolchainBoundaryErrors("RUN npm uninstall --global npm")).not.toEqual(
      [],
    );
    expect(
      containerRuntimeToolchainBoundaryErrors("RUN rm -rf /usr/local/lib/node_modules"),
    ).not.toEqual([]);
  });

  it("accepts only the scoped Git-free container install boundary", () => {
    expect(
      containerInstallBoundaryErrors(`
FROM node:24 AS build
RUN --mount=type=cache,id=reconai-pnpm-store,target=/pnpm/store,sharing=locked LEFTHOOK=0 pnpm install --frozen-lockfile
RUN pnpm build
RUN --mount=type=cache,id=reconai-pnpm-store,target=/pnpm/store,sharing=locked LEFTHOOK=0 pnpm --filter @workspace/api deploy --prod --legacy /release
`),
    ).toEqual([]);
  });

  it.each([
    ["unscoped install", "RUN pnpm install --frozen-lockfile"],
    ["persistent bypass", "ENV LEFTHOOK=0\nRUN LEFTHOOK=0 pnpm install --frozen-lockfile"],
    ["parameterized bypass", "ARG LEFTHOOK=0\nRUN LEFTHOOK=0 pnpm install --frozen-lockfile"],
    [
      "disabled lifecycle scripts",
      "RUN LEFTHOOK=0 pnpm install --frozen-lockfile --ignore-scripts",
    ],
    [
      "multiple installs",
      [
        "RUN LEFTHOOK=0 pnpm install --frozen-lockfile",
        "RUN LEFTHOOK=0 pnpm install --frozen-lockfile",
      ].join("\n"),
    ],
    [
      "unscoped production deploy",
      [
        "RUN LEFTHOOK=0 pnpm install --frozen-lockfile",
        "RUN pnpm --filter @workspace/api deploy --prod --legacy /release",
      ].join("\n"),
    ],
  ])("rejects %s in a container install boundary", (_name, source) => {
    expect(containerInstallBoundaryErrors(source)).not.toEqual([]);
  });

  it.each([
    ["api", "parseApiRuntimeConfig"],
    ["worker", "parseWorkerRuntimeConfig"],
  ])("accepts only the service-specific %s runtime parser", (service, parser) => {
    expect(
      serviceRuntimeParserBoundaryErrors(
        `import { ${parser} } from "@workspace/config";\nconst config = ${parser}(process.env);\n`,
        service,
      ),
    ).toEqual([]);
  });

  it("rejects the full-stack compatibility parser in a long-lived service", () => {
    expect(
      serviceRuntimeParserBoundaryErrors(
        'import { parseRuntimeConfig } from "@workspace/config";\n' +
          "const config = parseRuntimeConfig(process.env);\n",
        "api",
      ),
    ).toEqual([
      "must import only parseApiRuntimeConfig from @workspace/config",
      "must parse process.env with parseApiRuntimeConfig",
      "must not use the full-stack compatibility runtime parser",
    ]);
  });

  it("accepts only the reviewed post-incident Trivy action and scanner pins", () => {
    expect(
      releaseCandidateScannerBoundaryErrors(`
uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
with:
  version: v0.72.0
uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
with:
  skip-setup-trivy: true
`),
    ).toEqual([]);
  });

  it.each([
    [
      "a different action commit",
      `
uses: aquasecurity/trivy-action@57a97c7e5b3c7f31f9a942530951a21f5c8d4fa8
with:
  version: v0.72.0
uses: aquasecurity/trivy-action@57a97c7e5b3c7f31f9a942530951a21f5c8d4fa8
`,
    ],
    [
      "an inherited scanner default",
      `
uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
`,
    ],
    [
      "the compromised binary release",
      `
uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
with:
  version: v0.69.4
uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
`,
    ],
  ])("rejects %s", (_name, source) => {
    expect(releaseCandidateScannerBoundaryErrors(source)).not.toEqual([]);
  });

  it("pins the ordinary CI Node runtimes and container scanner", () => {
    expect(
      continuousIntegrationSecurityBoundaryErrors(`
steps:
  - name: Install Node.js
    uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    with:
      node-version: 24.18.0
  - name: Install browser Node.js
    uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    with:
      node-version: 24.18.0
  - name: Scan container vulnerabilities
    uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
    with:
      version: v0.72.0
      image-ref: reconai/api:ci
    env:
      DATABASE_MAINTENANCE_URL: ${"postgresql"}://synthetic-placeholder
`),
    ).toEqual([]);
  });

  it("requires maintenance-role authority for live CI integration suites", () => {
    const source = `
  - name: Install Node.js
    uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    with:
      node-version: 24.18.0
  - name: Install browser Node.js
    uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    with:
      node-version: 24.18.0
  - name: Scan container vulnerabilities
    uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
    with:
      version: v0.72.0
`;
    expect(continuousIntegrationSecurityBoundaryErrors(source)).toContain(
      "must provide the dedicated maintenance-role URL to live integration tests",
    );
  });

  it.each([
    [
      "an inherited CI scanner",
      `
  - name: Install Node.js
    uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    with:
      node-version: 24.18.0
  - name: Install browser Node.js
    uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    with:
      node-version: 24.18.0
  - name: Scan container vulnerabilities
    uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
`,
    ],
    [
      "an incident-affected CI scanner",
      `
  - name: Install Node.js
    uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    with:
      node-version: 24.18.0
  - name: Install browser Node.js
    uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    with:
      node-version: 24.18.0
  - name: Scan container vulnerabilities
    uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
    with:
      version: v0.69.4
`,
    ],
    [
      "a stale CI Node runtime",
      `
  - name: Install Node.js
    uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    with:
      node-version: 24.14.0
  - name: Install browser Node.js
    uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    with:
      node-version: 24.18.0
  - name: Scan container vulnerabilities
    uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
    with:
      version: v0.72.0
`,
    ],
  ])("rejects %s", (_name, source) => {
    expect(continuousIntegrationSecurityBoundaryErrors(source)).not.toEqual([]);
  });
});
