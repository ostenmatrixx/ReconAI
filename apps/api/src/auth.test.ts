import { OrganizationIdSchema } from "@workspace/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  OrganizationDirectoryCursorError,
  PostgresMembershipDirectory,
  PostgresOrganizationBootstrapper,
  type VerifiedIdentity,
} from "./auth.js";

const identity: VerifiedIdentity = {
  issuer: "https://issuer.example.test",
  subject: "operator-1",
  emailVerified: false,
};
const rows = [
  organizationRow(
    "00000000-0000-4000-8000-000000000001",
    "Alpha",
    "00000000-0000-4000-8000-000000000011",
  ),
  organizationRow(
    "00000000-0000-4000-8000-000000000002",
    "Beta",
    "00000000-0000-4000-8000-000000000012",
  ),
  organizationRow(
    "00000000-0000-4000-8000-000000000003",
    "Gamma",
    "00000000-0000-4000-8000-000000000013",
  ),
] as const;

describe("PostgreSQL membership directory", () => {
  it("creates a stable keyset cursor without returning the lookahead row", async () => {
    const query = vi.fn(async (): Promise<readonly Readonly<Record<string, unknown>>[]> => rows);
    const directory = new PostgresMembershipDirectory(query as unknown as Sql);

    const first = await directory.list(identity, { limit: 2 });

    expect(first.items.map(({ name }) => name)).toEqual(["Alpha", "Beta"]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.items[0]).not.toHaveProperty("sortName");

    query.mockResolvedValueOnce([rows[2]]);
    const second = await directory.list(identity, {
      limit: 2,
      cursor: requiredCursor(first.nextCursor),
    });
    expect(second).toEqual({
      items: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          name: "Gamma",
          membershipId: "00000000-0000-4000-8000-000000000013",
          role: "analyst",
        },
      ],
    });
    const secondValues = query.mock.calls[1]?.slice(1);
    expect(secondValues).toEqual([
      identity.issuer,
      identity.subject,
      null,
      null,
      "beta",
      "00000000-0000-4000-8000-000000000002",
      3,
    ]);
  });

  it("binds cursors to the normalized search and rejects malformed authority", async () => {
    const query = vi.fn(async (): Promise<readonly Readonly<Record<string, unknown>>[]> => rows);
    const directory = new PostgresMembershipDirectory(query as unknown as Sql);
    const searched = await directory.list(identity, { limit: 2, search: "North" });
    const cursor = requiredCursor(searched.nextCursor);

    await expect(
      directory.list(identity, { limit: 2, search: "South", cursor }),
    ).rejects.toBeInstanceOf(OrganizationDirectoryCursorError);
    await expect(
      directory.list(identity, { limit: 2, cursor: "not_canonical=" }),
    ).rejects.toBeInstanceOf(OrganizationDirectoryCursorError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("bounds page options and keeps exact lookup separate from search pagination", async () => {
    const query = vi.fn(async (): Promise<readonly Readonly<Record<string, unknown>>[]> => []);
    const directory = new PostgresMembershipDirectory(query as unknown as Sql);

    await expect(directory.list(identity, { limit: 0 })).rejects.toThrow("limit");
    await expect(directory.list(identity, { limit: 101 })).rejects.toThrow("limit");
    await expect(directory.list(identity, { limit: 10, search: " North " })).rejects.toThrow(
      "search",
    );
    await expect(
      directory.list(identity, {
        limit: 1,
        organizationId: OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001"),
        search: "North",
      }),
    ).rejects.toThrow("cannot be combined");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("PostgreSQL organization bootstrap", () => {
  const verifiedIdentity: VerifiedIdentity = {
    issuer: "https://issuer.example.test",
    subject: "bootstrap-owner",
    email: "bootstrap-owner@example.test",
    emailVerified: true,
  };
  const bootstrapRow = {
    bootstrap_status: "created",
    organization_id: "00000000-0000-4000-8000-000000000021",
    organization_name: "Bootstrap Tenant",
    business_time_zone: "Asia/Manila",
    membership_id: "00000000-0000-4000-8000-000000000022",
    user_id: "00000000-0000-4000-8000-000000000023",
    membership_role: "owner",
  } as const;

  it("creates the first owner and appends the first audit event in the same transaction", async () => {
    const database = bootstrapDatabase([bootstrapRow]);
    const bootstrapper = new PostgresOrganizationBootstrapper(database.sql);

    await expect(
      bootstrapper.bootstrap(verifiedIdentity, {
        name: "Bootstrap Tenant",
        businessTimeZone: "Asia/Manila",
        idempotencyKey: "00000000-0000-4000-8000-000000000024",
        correlationId: "00000000-0000-4000-8000-000000000025",
      }),
    ).resolves.toEqual({
      status: "created",
      access: {
        id: bootstrapRow.organization_id,
        name: "Bootstrap Tenant",
        membershipId: bootstrapRow.membership_id,
        role: "owner",
      },
      businessTimeZone: "Asia/Manila",
    });

    expect(database.begin).toHaveBeenCalledTimes(1);
    expect(database.querySql()).toContain("reconai_bootstrap_first_organization");
    expect(database.querySql()).toContain("set_config('app.organization_id'");
    expect(database.querySql()).toContain("insert into audit_events");
    expect(database.values()).toContain(verifiedIdentity.email);
  });

  it("replays without duplicating audit evidence and rejects unverified identities before SQL", async () => {
    const database = bootstrapDatabase([{ ...bootstrapRow, bootstrap_status: "replayed" }]);
    const bootstrapper = new PostgresOrganizationBootstrapper(database.sql);
    const request = {
      name: "Bootstrap Tenant",
      businessTimeZone: "Asia/Manila",
      idempotencyKey: "00000000-0000-4000-8000-000000000024",
      correlationId: "00000000-0000-4000-8000-000000000025",
    } as const;

    await expect(bootstrapper.bootstrap(verifiedIdentity, request)).resolves.toMatchObject({
      status: "replayed",
    });
    expect(database.querySql()).not.toContain("insert into audit_events");

    const unverifiedDatabase = bootstrapDatabase([bootstrapRow]);
    await expect(
      new PostgresOrganizationBootstrapper(unverifiedDatabase.sql).bootstrap(
        { ...verifiedIdentity, emailVerified: false },
        request,
      ),
    ).resolves.toEqual({ status: "identity_conflict" });
    expect(unverifiedDatabase.begin).not.toHaveBeenCalled();
  });

  it("propagates first-audit failure so the enclosing bootstrap transaction cannot commit", async () => {
    const database = bootstrapDatabase([bootstrapRow], { failAuditInsert: true });
    const bootstrapper = new PostgresOrganizationBootstrapper(database.sql);

    await expect(
      bootstrapper.bootstrap(verifiedIdentity, {
        name: "Bootstrap Tenant",
        businessTimeZone: "Asia/Manila",
        idempotencyKey: "00000000-0000-4000-8000-000000000024",
        correlationId: "00000000-0000-4000-8000-000000000025",
      }),
    ).rejects.toThrow("synthetic audit insert failure");
    expect(database.querySql()).toContain("reconai_bootstrap_first_organization");
    expect(database.querySql()).toContain("insert into audit_events");
  });
});

function organizationRow(
  organizationId: string,
  name: string,
  membershipId: string,
): Readonly<Record<string, unknown>> {
  return {
    organization_id: organizationId,
    organization_name: name,
    organization_sort_name: name.toLowerCase(),
    membership_id: membershipId,
    membership_role: "analyst",
  };
}

function requiredCursor(value: string | undefined): string {
  if (!value) throw new Error("expected a next cursor");
  return value;
}

function bootstrapDatabase(
  rows: readonly Readonly<Record<string, unknown>>[],
  options: { readonly failAuditInsert?: boolean } = {},
) {
  const query = vi.fn(
    async (
      strings: TemplateStringsArray,
      ..._values: readonly unknown[]
    ): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      const statement = strings.join(" ");
      if (options.failAuditInsert && statement.includes("insert into audit_events")) {
        throw new Error("synthetic audit insert failure");
      }
      return statement.includes("reconai_bootstrap_first_organization") ? rows : [];
    },
  );
  const transaction = Object.assign(query, {
    json: (value: unknown) => value,
  });
  const begin = vi.fn(async (callback: (sql: typeof transaction) => Promise<unknown>) =>
    callback(transaction),
  );
  return {
    sql: { begin } as unknown as Sql,
    begin,
    querySql: () => query.mock.calls.map(([strings]) => strings.join(" ")).join("\n"),
    values: () => query.mock.calls.flatMap(([, ...values]) => values),
  };
}
