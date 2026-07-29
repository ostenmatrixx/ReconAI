import { describe, expect, it } from "vitest";

import {
  admittedReconciliationRunCreationOperation,
  DEFAULT_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS,
  DEFAULT_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS,
  MAX_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS,
  MAX_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS,
  MIN_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS,
  MIN_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS,
  RECONCILIATION_RUN_INPUT_INSERT_BATCH_SIZE,
  ReconciliationRunAdmission,
  RepositoryRunCreationUnavailableError,
  reconciliationRunInputInsertBatches,
  reconciliationRunMaximumConcurrentTransactions,
  reconciliationRunTransactionTimeoutMilliseconds,
  settleReconciliationRunCreation,
  type ReconciliationRunInputIdentity,
} from "./repository.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";

describe("reconciliation run input insert batches", () => {
  it("bounds statement parameters while preserving every immutable identity and global ordinal", () => {
    const identities = Array.from(
      { length: RECONCILIATION_RUN_INPUT_INSERT_BATCH_SIZE * 2 + 1 },
      (_, index): ReconciliationRunInputIdentity => ({
        id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
        version: index + 1,
        contentSha256: index.toString(16).padStart(64, "0"),
      }),
    );

    const batches = Array.from(
      reconciliationRunInputInsertBatches(organizationId, runId, identities),
    );
    const flattened = batches.flat();

    expect(batches.map((batch) => batch.length)).toEqual([
      RECONCILIATION_RUN_INPUT_INSERT_BATCH_SIZE,
      RECONCILIATION_RUN_INPUT_INSERT_BATCH_SIZE,
      1,
    ]);
    expect(batches.every((batch) => batch.length * 6 < 65_535)).toBe(true);
    expect(flattened).toHaveLength(identities.length);
    expect(flattened).toEqual(
      identities.map((identity, ordinal) => ({
        organization_id: organizationId,
        run_id: runId,
        record_id: identity.id,
        record_version: identity.version,
        content_sha256: identity.contentSha256,
        ordinal,
      })),
    );
  });

  it("does not issue an empty insert batch for an empty snapshot", () => {
    expect(Array.from(reconciliationRunInputInsertBatches(organizationId, runId, []))).toEqual([]);
  });
});

describe("reconciliation run transaction deadline", () => {
  it("defaults to a bounded deadline and accepts both documented boundaries", () => {
    expect(reconciliationRunTransactionTimeoutMilliseconds()).toBe(
      DEFAULT_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS,
    );
    expect(
      reconciliationRunTransactionTimeoutMilliseconds(
        MIN_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS,
      ),
    ).toBe(MIN_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS);
    expect(
      reconciliationRunTransactionTimeoutMilliseconds(
        MAX_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS,
      ),
    ).toBe(MAX_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS);
  });

  it("rejects non-integer and out-of-range deadlines before database access", () => {
    for (const value of [
      MIN_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS - 1,
      MAX_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS + 1,
      30_000.5,
      Number.NaN,
    ]) {
      expect(() => reconciliationRunTransactionTimeoutMilliseconds(value)).toThrow(RangeError);
    }
  });

  it("settles on interruption while safely observing a later pool operation result", async () => {
    const operation = Promise.withResolvers<string>();
    const controller = new AbortController();
    const settlement = settleReconciliationRunCreation(operation.promise, controller.signal);

    controller.abort();

    await expect(settlement).rejects.toBeInstanceOf(RepositoryRunCreationUnavailableError);
    operation.resolve("late authority result");
    await expect(operation.promise).resolves.toBe("late authority result");
  });

  it("returns a completed operation and ignores a later abort", async () => {
    const controller = new AbortController();
    const settlement = settleReconciliationRunCreation(
      Promise.resolve("complete authority"),
      controller.signal,
    );

    await expect(settlement).resolves.toBe("complete authority");
    controller.abort();
  });
});

describe("reconciliation run transaction admission", () => {
  it("defaults to a small bound and accepts both documented boundaries", () => {
    expect(reconciliationRunMaximumConcurrentTransactions()).toBe(
      DEFAULT_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS,
    );
    expect(
      reconciliationRunMaximumConcurrentTransactions(
        MIN_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS,
      ),
    ).toBe(MIN_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS);
    expect(
      reconciliationRunMaximumConcurrentTransactions(
        MAX_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS,
      ),
    ).toBe(MAX_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS);
  });

  it("rejects non-integer and out-of-range bounds before database access", () => {
    for (const value of [
      MIN_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS - 1,
      MAX_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS + 1,
      2.5,
      Number.NaN,
    ]) {
      expect(() => reconciliationRunMaximumConcurrentTransactions(value)).toThrow(RangeError);
    }
  });

  it("retains an admitted slot until hidden pool work settles after the caller is interrupted", async () => {
    const admission = new ReconciliationRunAdmission(1);
    const operation = Promise.withResolvers<string>();
    const firstOperation = admittedReconciliationRunCreationOperation(
      admission,
      () => operation.promise,
    );
    const controller = new AbortController();
    const firstSettlement = settleReconciliationRunCreation(firstOperation, controller.signal);

    controller.abort();
    await expect(firstSettlement).rejects.toMatchObject({
      name: "RepositoryRunCreationUnavailableError",
      reason: "interrupted",
    });

    let rejectedFactoryCalled = false;
    await expect(
      admittedReconciliationRunCreationOperation(admission, () => {
        rejectedFactoryCalled = true;
        return Promise.resolve("must not run");
      }),
    ).rejects.toMatchObject({
      name: "RepositoryRunCreationUnavailableError",
      reason: "admission_saturated",
    });
    expect(rejectedFactoryCalled).toBe(false);

    operation.resolve("drained");
    await expect(firstOperation).resolves.toBe("drained");
    await expect(
      admittedReconciliationRunCreationOperation(admission, () => Promise.resolve("reopened")),
    ).resolves.toBe("reopened");
  });

  it("releases admission after synchronous operation construction failure", async () => {
    const admission = new ReconciliationRunAdmission(1);

    await expect(
      admittedReconciliationRunCreationOperation(admission, () => {
        throw new Error("synthetic operation construction failure");
      }),
    ).rejects.toThrow("synthetic operation construction failure");
    await expect(
      admittedReconciliationRunCreationOperation(admission, () => Promise.resolve("reopened")),
    ).resolves.toBe("reopened");
  });
});
