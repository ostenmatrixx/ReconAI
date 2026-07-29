import type { TenantContext } from "@workspace/domain";
import type { Sql, TransactionSql } from "postgres";

export async function withTenantTransaction<T>(
  sql: Sql,
  tenant: TenantContext,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${tenant.organizationId}, true)`;
    const value =
      await transaction`select current_setting('app.organization_id', true) as organization_id`;
    if (value[0]?.["organization_id"] !== tenant.organizationId) {
      throw new Error("database tenant context was not established");
    }
    return operation(transaction);
  }) as Promise<T>;
}
