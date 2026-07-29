import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const membershipStatus = pgEnum("membership_status", ["invited", "active", "deactivated"]);
export const organizationInvitationStatus = pgEnum("organization_invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export const sourceSystem = pgEnum("source_system", ["shopify", "stripe", "accounting_csv"]);
export const recordKind = pgEnum("canonical_record_kind", [
  "order",
  "payment",
  "refund",
  "processing_fee",
  "accounting_entry",
]);
export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "partial",
  "succeeded",
  "failed",
  "cancelled",
]);
export const exceptionStatus = pgEnum("exception_status", [
  "open",
  "assigned",
  "deferred",
  "proposed",
  "approved",
  "rejected",
  "superseded",
]);
export const importStatus = pgEnum("import_status", [
  "previewed",
  "validation_failed",
  "queued",
  "succeeded",
  "failed",
  "rolled_back",
]);

export const organizations = pgTable("organizations", {
  id: uuid().primaryKey(),
  name: text().notNull(),
  profileVersion: integer("profile_version").notNull().default(1),
  businessTimeZone: text("business_time_zone").notNull().default("UTC"),
  status: text().notNull().default("active"),
  aiEnabled: boolean("ai_enabled").notNull().default(false),
  dualApprovalEnabled: boolean("dual_approval_enabled").notNull().default(true),
  dualApprovalThresholds: jsonb("dual_approval_thresholds").notNull().default({}),
  sensitiveResolutionTypes: jsonb("sensitive_resolution_types")
    .notNull()
    .default(["write_off", "manual_override", "document_external_payment"]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey(),
    issuer: text().notNull(),
    subject: text().notNull(),
    email: text(),
    status: text().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_issuer_subject_uidx").on(table.issuer, table.subject)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text().notNull(),
    status: membershipStatus().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex("memberships_org_user_uidx").on(table.organizationId, table.userId),
    index("memberships_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    email: text().notNull(),
    role: text().notNull(),
    status: organizationInvitationStatus().notNull().default("pending"),
    tokenSha256: char("token_sha256", { length: 64 }).notNull(),
    invitedByMembershipId: uuid("invited_by_membership_id").notNull(),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id),
    acceptedMembershipId: uuid("accepted_membership_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.invitedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "organization_invitations_inviter_membership_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.acceptedMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "organization_invitations_accepted_membership_fk",
    }),
    uniqueIndex("organization_invitations_token_uidx").on(table.tokenSha256),
    index("organization_invitations_org_status_expiry_idx").on(
      table.organizationId,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const organizationBootstrapRequests = pgTable(
  "organization_bootstrap_requests",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    membershipId: uuid("membership_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    inputSha256: char("input_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "organization_bootstrap_requests_membership_fk",
    }),
    uniqueIndex("organization_bootstrap_requests_identity_idempotency_uidx").on(
      table.userId,
      table.idempotencyKey,
    ),
    index("organization_bootstrap_requests_org_created_idx").on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const supportAccessRequests = pgTable(
  "support_access_requests",
  {
    id: uuid().primaryKey(),
    supportIdentityDigest: char("support_identity_digest", { length: 64 }).notNull(),
    requestTokenSha256: char("request_token_sha256", { length: 64 }).notNull(),
    requestedDurationMinutes: integer("requested_duration_minutes").notNull(),
    status: text().notNull().default("pending"),
    requestExpiresAt: timestamp("request_expires_at", { withTimezone: true }).notNull(),
    claimedOrganizationId: uuid("claimed_organization_id").references(() => organizations.id),
    claimedGrantId: uuid("claimed_grant_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("support_access_requests_token_uidx").on(table.requestTokenSha256),
    index("support_access_requests_identity_expiry_idx").on(
      table.supportIdentityDigest,
      table.requestExpiresAt,
      table.id,
    ),
    check(
      "support_access_requests_identity_digest_check",
      sql`${table.supportIdentityDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "support_access_requests_token_digest_check",
      sql`${table.requestTokenSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "support_access_requests_duration_check",
      sql`${table.requestedDurationMinutes} between 5 and 60`,
    ),
    check(
      "support_access_requests_expiry_check",
      sql`${table.requestExpiresAt} = ${table.createdAt} + interval '15 minutes'`,
    ),
    check(
      "support_access_requests_state_check",
      sql`(
        ${table.status} = 'pending'
        and ${table.claimedOrganizationId} is null
        and ${table.claimedGrantId} is null
        and ${table.claimedAt} is null
      ) or (
        ${table.status} = 'claimed'
        and ${table.claimedOrganizationId} is not null
        and ${table.claimedGrantId} is not null
        and ${table.claimedAt} is not null
      )`,
    ),
  ],
);

export const supportAccessGrants = pgTable(
  "support_access_grants",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    supportIdentityDigest: char("support_identity_digest", { length: 64 }).notNull(),
    capability: text().notNull(),
    ticketReference: text("ticket_reference").notNull(),
    reason: text().notNull(),
    approvedByMembershipId: uuid("approved_by_membership_id").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text().notNull().default("active"),
    revokedByMembershipId: uuid("revoked_by_membership_id"),
    revocationReason: text("revocation_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.approvedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "support_access_grants_approver_membership_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.revokedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "support_access_grants_revoker_membership_fk",
    }),
    index("support_access_grants_org_created_idx").on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
    index("support_access_grants_authority_idx").on(
      table.organizationId,
      table.id,
      table.supportIdentityDigest,
      table.status,
      table.expiresAt,
    ),
    check(
      "support_access_grants_identity_digest_check",
      sql`${table.supportIdentityDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check("support_access_grants_capability_check", sql`${table.capability} = 'diagnostics:view'`),
    check(
      "support_access_grants_duration_check",
      sql`${table.expiresAt} between
        ${table.approvedAt} + interval '5 minutes'
        and ${table.approvedAt} + interval '60 minutes'`,
    ),
    check("support_access_grants_created_check", sql`${table.createdAt} = ${table.approvedAt}`),
    check(
      "support_access_grants_reason_check",
      sql`length(${table.ticketReference}) between 3 and 200
        and ${table.ticketReference} !~ '[[:cntrl:]]'
        and length(${table.reason}) between 3 and 2000
        and ${table.reason} !~ '[[:cntrl:]]'`,
    ),
    check(
      "support_access_grants_state_check",
      sql`(
        ${table.status} = 'active'
        and ${table.revokedByMembershipId} is null
        and ${table.revocationReason} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.status} = 'revoked'
        and ${table.revokedByMembershipId} is not null
        and ${table.revocationReason} is not null
        and ${table.revokedAt} is not null
      )`,
    ),
  ],
);

export const organizationRetentionPolicies = pgTable(
  "organization_retention_policies",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id),
    rawImportRetentionDays: integer("raw_import_retention_days"),
    providerEventRetentionDays: integer("provider_event_retention_days"),
    legalHoldEnabled: boolean("legal_hold_enabled").notNull().default(false),
    legalHoldReason: text("legal_hold_reason"),
    updatedByMembershipId: uuid("updated_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.updatedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "organization_retention_policies_updater_membership_fk",
    }),
  ],
);

export const connections = pgTable(
  "data_source_connections",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    provider: sourceSystem().notNull(),
    externalAccountId: text("external_account_id").notNull(),
    status: text().notNull(),
    connectorVersion: text("connector_version").notNull(),
    apiVersion: text("api_version"),
    encryptedCredential: text("encrypted_credential"),
    credentialReference: text("credential_reference"),
    apiCredentialReference: text("api_credential_reference"),
    credentialKeyVersion: text("credential_key_version"),
    cursor: text(),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    lastVerifiedWebhookAt: timestamp("last_verified_webhook_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex("connections_provider_account_uidx").on(table.provider, table.externalAccountId),
    index("connections_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const connectorCredentials = pgTable(
  "connector_credentials",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    connectionId: uuid("connection_id").notNull(),
    purpose: text().notNull(),
    encryptedEnvelope: jsonb("encrypted_envelope").notNull(),
    keyVersion: text("key_version").notNull(),
    envelopeSha256: char("envelope_sha256", { length: 64 }).notNull(),
    status: text().notNull().default("active"),
    createdByMembershipId: uuid("created_by_membership_id"),
    createdByService: text("created_by_service"),
    rotatedFromCredentialId: uuid("rotated_from_credential_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
      name: "connector_credentials_connection_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "connector_credentials_creator_membership_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.rotatedFromCredentialId],
      foreignColumns: [table.organizationId, table.id],
      name: "connector_credentials_rotated_from_fk",
    }),
    uniqueIndex("connector_credentials_active_purpose_uidx")
      .on(table.organizationId, table.connectionId, table.purpose)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("connector_credentials_org_envelope_uidx").on(
      table.organizationId,
      table.envelopeSha256,
    ),
    index("connector_credentials_org_connection_created_idx").on(
      table.organizationId,
      table.connectionId,
      table.createdAt,
    ),
  ],
);

export const providerAuthorizationAttempts = pgTable(
  "provider_authorization_attempts",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    connectionId: uuid("connection_id").notNull(),
    provider: sourceSystem().notNull(),
    stateSha256: char("state_sha256", { length: 64 }).notNull(),
    status: text().notNull().default("pending"),
    requestedAccountId: text("requested_account_id"),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
      name: "provider_authorization_attempts_connection_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "provider_authorization_attempts_requester_membership_fk",
    }),
    uniqueIndex("provider_authorization_attempts_state_uidx").on(table.stateSha256),
    uniqueIndex("provider_authorization_attempts_active_connection_uidx")
      .on(table.organizationId, table.connectionId)
      .where(sql`${table.status} in ('pending', 'exchanging')`),
    index("provider_authorization_attempts_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export const providerDeauthorizationEvents = pgTable(
  "provider_deauthorization_events",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    connectionId: uuid("connection_id").notNull(),
    provider: sourceSystem().notNull(),
    externalEventId: text("external_event_id").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    livemode: boolean().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
      name: "provider_deauthorization_events_connection_fk",
    }),
    uniqueIndex("provider_deauthorization_events_provider_event_uidx").on(
      table.provider,
      table.externalEventId,
    ),
    index("provider_deauthorization_events_org_connection_received_idx").on(
      table.organizationId,
      table.connectionId,
      table.receivedAt,
    ),
  ],
);

export const providerPrivacyRequests = pgTable(
  "provider_privacy_requests",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    connectionId: uuid("connection_id").notNull(),
    provider: sourceSystem().notNull(),
    externalEventId: text("external_event_id").notNull(),
    topic: text().notNull(),
    apiVersion: text("api_version").notNull(),
    externalShopId: text("external_shop_id").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    externalSubjectId: text("external_subject_id"),
    externalRequestId: text("external_request_id"),
    externalObjectIds: jsonb("external_object_ids").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    status: text().notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
      name: "provider_privacy_requests_connection_fk",
    }),
    uniqueIndex("provider_privacy_requests_provider_event_uidx").on(
      table.provider,
      table.externalEventId,
    ),
    index("provider_privacy_requests_org_connection_due_idx").on(
      table.organizationId,
      table.connectionId,
      table.dueAt,
    ),
  ],
);

export const providerPrivacyRequestDeadlineAlerts = pgTable(
  "provider_privacy_request_deadline_alerts",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    requestId: uuid("request_id").notNull(),
    stage: text().notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [providerPrivacyRequests.organizationId, providerPrivacyRequests.id],
      name: "provider_privacy_request_deadline_alerts_request_fk",
    }),
    uniqueIndex("provider_privacy_request_deadline_alerts_request_stage_uidx").on(
      table.organizationId,
      table.requestId,
      table.stage,
    ),
    index("provider_privacy_request_deadline_alerts_org_due_idx").on(
      table.organizationId,
      table.dueAt,
      table.observedAt,
    ),
  ],
);

export const providerPrivacyDataPackages = pgTable(
  "provider_privacy_data_packages",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    requestId: uuid("request_id").notNull(),
    preparedByMembershipId: uuid("prepared_by_membership_id").notNull(),
    contentSha256: char("content_sha256", { length: 64 }).notNull(),
    byteCount: integer("byte_count").notNull(),
    receiptTokenSha256: char("receipt_token_sha256", { length: 64 }).notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull(),
    receiptExpiresAt: timestamp("receipt_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [providerPrivacyRequests.organizationId, providerPrivacyRequests.id],
      name: "provider_privacy_data_packages_request_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.preparedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "provider_privacy_data_packages_preparer_membership_fk",
    }),
    uniqueIndex("provider_privacy_data_packages_token_uidx").on(table.receiptTokenSha256),
    index("provider_privacy_data_packages_request_prepared_idx").on(
      table.organizationId,
      table.requestId,
      table.preparedAt,
      table.id,
    ),
    check(
      "provider_privacy_data_packages_content_hash_check",
      sql`${table.contentSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "provider_privacy_data_packages_token_hash_check",
      sql`${table.receiptTokenSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "provider_privacy_data_packages_byte_count_check",
      sql`${table.byteCount} between 1 and 5242880`,
    ),
    check(
      "provider_privacy_data_packages_expiry_check",
      sql`${table.receiptExpiresAt} = ${table.preparedAt} + interval '10 minutes'`,
    ),
    check(
      "provider_privacy_data_packages_created_check",
      sql`${table.createdAt} = ${table.preparedAt}`,
    ),
  ],
);

export const providerPrivacyDataPackageReceipts = pgTable(
  "provider_privacy_data_package_receipts",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    packageId: uuid("package_id").notNull(),
    receivedByMembershipId: uuid("received_by_membership_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.packageId],
      foreignColumns: [providerPrivacyDataPackages.organizationId, providerPrivacyDataPackages.id],
      name: "provider_privacy_data_package_receipts_package_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.receivedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "provider_privacy_data_package_receipts_membership_fk",
    }),
    uniqueIndex("provider_privacy_data_package_receipts_package_uidx").on(
      table.organizationId,
      table.packageId,
    ),
    check(
      "provider_privacy_data_package_receipts_created_check",
      sql`${table.createdAt} = ${table.receivedAt}`,
    ),
  ],
);

export const providerSyncRuns = pgTable(
  "provider_sync_runs",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    connectionId: uuid("connection_id").notNull(),
    provider: sourceSystem().notNull(),
    mode: text().notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    cursor: text(),
    status: text().notNull(),
    pageCount: integer("page_count").notNull().default(0),
    itemCount: integer("item_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    maximumPages: integer("maximum_pages").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    idempotencyKey: char("idempotency_key", { length: 64 }).notNull(),
    correlationId: uuid("correlation_id").notNull(),
    requesterType: text("requester_type").notNull().default("user"),
    requestedByMembershipId: uuid("requested_by_membership_id"),
    requestedByService: text("requested_by_service"),
    lastErrorCode: text("last_error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
      name: "provider_sync_runs_connection_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "provider_sync_runs_requester_membership_fk",
    }),
    uniqueIndex("provider_sync_runs_org_idempotency_uidx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("provider_sync_runs_org_connection_created_idx").on(
      table.organizationId,
      table.connectionId,
      table.createdAt,
    ),
    index("provider_sync_runs_active_oldest_idx")
      .on(table.provider, table.createdAt, table.id)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);

export const imports = pgTable(
  "imports",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    connectionId: uuid("connection_id").notNull(),
    source: sourceSystem().notNull().default("accounting_csv"),
    objectKey: text("object_key").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    byteCount: integer("byte_count").notNull(),
    contentType: text("content_type").notNull(),
    originalFilename: text("original_filename").notNull(),
    templateVersion: text("template_version").notNull(),
    mappingVersion: text("mapping_version").notNull(),
    mapping: jsonb().notNull(),
    status: importStatus().notNull(),
    idempotencyKey: char("idempotency_key", { length: 64 }).notNull(),
    rowCount: integer("row_count").notNull().default(0),
    validRowCount: integer("valid_row_count").notNull().default(0),
    invalidRowCount: integer("invalid_row_count").notNull().default(0),
    previewRows: jsonb("preview_rows").notNull(),
    previewErrors: jsonb("preview_errors").notNull(),
    errorsTruncated: boolean("errors_truncated").notNull().default(false),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    supersededRecordCount: integer("superseded_record_count"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
      name: "imports_connection_fk",
    }),
    uniqueIndex("imports_idempotency_uidx").on(table.organizationId, table.idempotencyKey),
    index("imports_org_status_idx").on(table.organizationId, table.status, table.createdAt),
  ],
);

export const sourceEvents = pgTable(
  "source_events",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    connectionId: uuid("connection_id").notNull(),
    importId: uuid("import_id"),
    source: sourceSystem().notNull(),
    externalEventId: text("external_event_id").notNull(),
    externalObjectType: text("external_object_type").notNull(),
    externalObjectId: text("external_object_id").notNull(),
    sourceTimestamp: timestamp("source_timestamp", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    connectorVersion: text("connector_version").notNull(),
    apiVersion: text("api_version"),
    payloadObjectKey: text("payload_object_key").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    status: text().notNull(),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
      name: "source_events_connection_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.importId],
      foreignColumns: [imports.organizationId, imports.id],
      name: "source_events_import_fk",
    }),
    uniqueIndex("source_events_receipt_uidx").on(
      table.organizationId,
      table.connectionId,
      table.source,
      table.externalEventId,
    ),
    index("source_events_org_object_idx").on(
      table.organizationId,
      table.source,
      table.externalObjectType,
      table.externalObjectId,
    ),
    index("source_events_org_connection_object_watermark_idx").on(
      table.organizationId,
      table.connectionId,
      table.externalObjectType,
      table.sourceTimestamp.desc(),
      table.receivedAt.desc(),
    ),
  ],
);

export const sourceEventObjectClassifications = pgTable(
  "source_event_object_classifications",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    sourceEventId: uuid("source_event_id").notNull(),
    objectFamilies: text("object_families").array().notNull(),
    classifierVersion: text("classifier_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.sourceEventId] }),
    foreignKey({
      columns: [table.organizationId, table.sourceEventId],
      foreignColumns: [sourceEvents.organizationId, sourceEvents.id],
      name: "source_event_object_classifications_source_event_fk",
    }),
    check(
      "source_event_object_classifications_families_check",
      sql`
        cardinality(${table.objectFamilies}) BETWEEN 1 AND 3
        AND array_position(${table.objectFamilies}, NULL) IS NULL
        AND (
          ${table.objectFamilies} = ARRAY['order']::text[]
          OR ${table.objectFamilies} = ARRAY['refund_transaction']::text[]
          OR ${table.objectFamilies} = ARRAY['order', 'refund_transaction']::text[]
          OR ${table.objectFamilies} = ARRAY['payment_intent']::text[]
          OR ${table.objectFamilies} = ARRAY['refund']::text[]
          OR ${table.objectFamilies} = ARRAY['balance_transaction']::text[]
          OR ${table.objectFamilies} = ARRAY['csv_row']::text[]
        )
      `,
    ),
    check(
      "source_event_object_classifications_classifier_check",
      sql`${table.classifierVersion} = 'source-object-family-v1'`,
    ),
  ],
);

export const providerPrivacyObjectDeletionJobs = pgTable(
  "provider_privacy_object_deletion_jobs",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    requestId: uuid("request_id").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    objectKey: text("object_key").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    status: text().notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastErrorCode: text("last_error_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [providerPrivacyRequests.organizationId, providerPrivacyRequests.id],
      name: "provider_privacy_object_deletion_jobs_request_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.sourceEventId],
      foreignColumns: [sourceEvents.organizationId, sourceEvents.id],
      name: "provider_privacy_object_deletion_jobs_source_fk",
    }),
    uniqueIndex("provider_privacy_object_deletion_jobs_request_source_uidx").on(
      table.organizationId,
      table.requestId,
      table.sourceEventId,
    ),
    index("provider_privacy_object_deletion_jobs_retry_idx").on(
      table.status,
      table.nextAttemptAt,
      table.organizationId,
    ),
  ],
);

export const providerPrivacyObjectDeletionTombstones = pgTable(
  "provider_privacy_object_deletion_tombstones",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    jobId: uuid("job_id").notNull(),
    requestId: uuid("request_id").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    objectKey: text("object_key").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    outcome: text().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.jobId],
      foreignColumns: [
        providerPrivacyObjectDeletionJobs.organizationId,
        providerPrivacyObjectDeletionJobs.id,
      ],
      name: "provider_privacy_object_deletion_tombstones_job_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [providerPrivacyRequests.organizationId, providerPrivacyRequests.id],
      name: "provider_privacy_object_deletion_tombstones_request_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.sourceEventId],
      foreignColumns: [sourceEvents.organizationId, sourceEvents.id],
      name: "provider_privacy_object_deletion_tombstones_source_fk",
    }),
    uniqueIndex("provider_privacy_object_deletion_tombstones_job_uidx").on(
      table.organizationId,
      table.jobId,
    ),
    index("provider_privacy_object_deletion_tombstones_request_idx").on(
      table.organizationId,
      table.requestId,
      table.deletedAt,
    ),
  ],
);

export const retentionDeletionJobs = pgTable(
  "retention_deletion_jobs",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    sourceKind: text("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    objectKey: text("object_key").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    retentionDays: integer("retention_days").notNull(),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }).notNull(),
    status: text().notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastErrorCode: text("last_error_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex("retention_deletion_jobs_org_source_uidx").on(
      table.organizationId,
      table.sourceKind,
      table.sourceId,
    ),
    index("retention_deletion_jobs_retry_idx").on(
      table.status,
      table.nextAttemptAt,
      table.organizationId,
    ),
  ],
);

export const retentionDeletionTombstones = pgTable(
  "retention_deletion_tombstones",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    jobId: uuid("job_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    objectKey: text("object_key").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    retentionDays: integer("retention_days").notNull(),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }).notNull(),
    outcome: text().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.jobId],
      foreignColumns: [retentionDeletionJobs.organizationId, retentionDeletionJobs.id],
      name: "retention_deletion_tombstones_job_fk",
    }),
    uniqueIndex("retention_deletion_tombstones_org_source_uidx").on(
      table.organizationId,
      table.sourceKind,
      table.sourceId,
    ),
    uniqueIndex("retention_deletion_tombstones_org_object_uidx").on(
      table.organizationId,
      table.objectKey,
    ),
    index("retention_deletion_tombstones_org_time_idx").on(table.organizationId, table.deletedAt),
  ],
);

export const canonicalRecords = pgTable(
  "canonical_records",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    version: integer().notNull(),
    kind: recordKind().notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    source: sourceSystem().notNull(),
    externalObjectType: text("external_object_type").notNull(),
    externalObjectId: text("external_object_id").notNull(),
    sourceTimestamp: timestamp("source_timestamp", { withTimezone: true }).notNull(),
    ingestionTimestamp: timestamp("ingestion_timestamp", { withTimezone: true }).notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    connectorVersion: text("connector_version").notNull(),
    normalizerVersion: text("normalizer_version").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char({ length: 3 }).notNull(),
    orderReference: text("order_reference"),
    customerReference: text("customer_reference"),
    normalizedData: jsonb("normalized_data").notNull(),
    contentSha256: char("content_sha256", { length: 64 }).notNull(),
    isIncomplete: boolean("is_incomplete").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id, table.version] }),
    foreignKey({
      columns: [table.organizationId, table.sourceEventId],
      foreignColumns: [sourceEvents.organizationId, sourceEvents.id],
      name: "canonical_records_source_event_fk",
    }),
    uniqueIndex("canonical_source_normalizer_uidx").on(
      table.organizationId,
      table.sourceEventId,
      table.normalizerVersion,
      table.kind,
      table.externalObjectId,
    ),
    index("canonical_org_kind_time_idx").on(table.organizationId, table.kind, table.effectiveAt),
    index("canonical_org_order_ref_idx").on(table.organizationId, table.orderReference),
  ],
);

export const canonicalFieldProvenance = pgTable(
  "canonical_field_provenance",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    recordId: uuid("record_id").notNull(),
    recordVersion: integer("record_version").notNull(),
    fieldPath: text("field_path").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    sourceValueReference: text("source_value_reference").notNull(),
    normalizedValue: jsonb("normalized_value").notNull(),
    transformationRule: text("transformation_rule").notNull(),
    transformationVersion: text("transformation_version").notNull(),
    warnings: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.recordId, table.recordVersion, table.fieldPath],
    }),
    foreignKey({
      columns: [table.organizationId, table.recordId, table.recordVersion],
      foreignColumns: [
        canonicalRecords.organizationId,
        canonicalRecords.id,
        canonicalRecords.version,
      ],
      name: "canonical_field_provenance_record_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.sourceEventId],
      foreignColumns: [sourceEvents.organizationId, sourceEvents.id],
      name: "canonical_field_provenance_source_event_fk",
    }),
    index("canonical_field_provenance_org_source_idx").on(
      table.organizationId,
      table.sourceEventId,
    ),
  ],
);

export const canonicalRecordSupersessions = pgTable(
  "canonical_record_supersessions",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    recordId: uuid("record_id").notNull(),
    recordVersion: integer("record_version").notNull(),
    sourceImportId: uuid("source_import_id").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    correlationId: uuid("correlation_id").notNull(),
    reason: text().notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.recordId, table.recordVersion],
    }),
    foreignKey({
      columns: [table.organizationId, table.recordId, table.recordVersion],
      foreignColumns: [
        canonicalRecords.organizationId,
        canonicalRecords.id,
        canonicalRecords.version,
      ],
      name: "canonical_record_supersessions_record_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.sourceImportId],
      foreignColumns: [imports.organizationId, imports.id],
      name: "canonical_record_supersessions_import_fk",
    }),
    index("canonical_record_supersessions_org_import_idx").on(
      table.organizationId,
      table.sourceImportId,
    ),
  ],
);

export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    stableRunKey: char("stable_run_key", { length: 64 }).notNull(),
    inputSnapshotHash: char("input_snapshot_hash", { length: 64 }).notNull(),
    policySnapshotHash: char("policy_snapshot_hash", { length: 64 }).notNull(),
    policySnapshot: jsonb("policy_snapshot").notNull(),
    policyVersion: text("policy_version").notNull(),
    ruleSetVersion: text("rule_set_version").notNull(),
    engineVersion: text("engine_version").notNull(),
    initiatedBy: uuid("initiated_by")
      .notNull()
      .references(() => users.id),
    status: runStatus().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    inputCount: integer("input_count").notNull().default(0),
    matchCount: integer("match_count").notNull().default(0),
    exceptionCount: integer("exception_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    dispatchCount: integer("dispatch_count").notNull().default(1),
    operationalStateApplied: boolean("operational_state_applied").notNull().default(false),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex("reconciliation_runs_stable_uidx").on(table.organizationId, table.stableRunKey),
    index("reconciliation_runs_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);

export const reconciliationRunInputs = pgTable(
  "reconciliation_run_inputs",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: uuid("run_id").notNull(),
    recordId: uuid("record_id").notNull(),
    recordVersion: integer("record_version").notNull(),
    contentSha256: char("content_sha256", { length: 64 }).notNull(),
    ordinal: integer().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.runId, table.recordId, table.recordVersion],
    }),
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [reconciliationRuns.organizationId, reconciliationRuns.id],
      name: "reconciliation_run_inputs_run_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.recordId, table.recordVersion],
      foreignColumns: [
        canonicalRecords.organizationId,
        canonicalRecords.id,
        canonicalRecords.version,
      ],
      name: "reconciliation_run_inputs_record_fk",
    }),
    uniqueIndex("reconciliation_run_inputs_org_run_ordinal_uidx").on(
      table.organizationId,
      table.runId,
      table.ordinal,
    ),
    index("reconciliation_run_inputs_org_record_idx").on(
      table.organizationId,
      table.recordId,
      table.recordVersion,
    ),
  ],
);

export const matches = pgTable(
  "matches",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: uuid("run_id").notNull(),
    stableKey: char("stable_key", { length: 64 }).notNull(),
    ruleId: text("rule_id").notNull(),
    ruleVersion: text("rule_version").notNull(),
    recordReferences: jsonb("record_references").notNull(),
    evidence: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [reconciliationRuns.organizationId, reconciliationRuns.id],
      name: "matches_run_fk",
    }),
    uniqueIndex("matches_stable_uidx").on(table.organizationId, table.stableKey),
    index("matches_org_run_idx").on(table.organizationId, table.runId),
  ],
);

export const matchOccurrences = pgTable(
  "match_occurrences",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: uuid("run_id").notNull(),
    matchId: uuid("match_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.runId, table.matchId] }),
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [reconciliationRuns.organizationId, reconciliationRuns.id],
      name: "match_occurrences_run_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.matchId],
      foreignColumns: [matches.organizationId, matches.id],
      name: "match_occurrences_match_fk",
    }),
    index("match_occurrences_org_match_idx").on(table.organizationId, table.matchId),
  ],
);

export const matchOccurrenceSnapshots = pgTable(
  "match_occurrence_snapshots",
  {
    organizationId: uuid("organization_id").notNull(),
    runId: uuid("run_id").notNull(),
    matchId: uuid("match_id").notNull(),
    snapshotVersion: text("snapshot_version").notNull(),
    ruleId: text("rule_id").notNull(),
    ruleVersion: text("rule_version").notNull(),
    recordReferences: jsonb("record_references").notNull(),
    evidence: jsonb().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.runId, table.matchId] }),
    foreignKey({
      columns: [table.organizationId, table.runId, table.matchId],
      foreignColumns: [
        matchOccurrences.organizationId,
        matchOccurrences.runId,
        matchOccurrences.matchId,
      ],
      name: "match_occurrence_snapshots_occurrence_fk",
    }),
    check(
      "match_occurrence_snapshots_version_check",
      sql`${table.snapshotVersion} = 'artifact-occurrence-v1'`,
    ),
    check(
      "match_occurrence_snapshots_rule_id_check",
      sql`${table.ruleId} ~ '^[a-z0-9][a-z0-9-]{0,99}$'`,
    ),
    check(
      "match_occurrence_snapshots_rule_version_check",
      sql`${table.ruleVersion} ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'`,
    ),
    check(
      "match_occurrence_snapshots_references_check",
      sql`jsonb_typeof(${table.recordReferences}) = 'array'`,
    ),
    check(
      "match_occurrence_snapshots_evidence_check",
      sql`jsonb_typeof(${table.evidence}) = 'object'`,
    ),
  ],
);

export const exceptions = pgTable(
  "exceptions",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    stableKey: char("stable_key", { length: 64 }).notNull(),
    firstRunId: uuid("first_run_id").notNull(),
    latestRunId: uuid("latest_run_id").notNull(),
    type: text().notNull(),
    status: exceptionStatus().notNull(),
    severity: text().notNull(),
    recordReferences: jsonb("record_references").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    currency: char({ length: 3 }),
    evidence: jsonb().notNull(),
    assigneeMembershipId: uuid("assignee_membership_id"),
    deferredUntil: timestamp("deferred_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.firstRunId],
      foreignColumns: [reconciliationRuns.organizationId, reconciliationRuns.id],
      name: "exceptions_first_run_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.latestRunId],
      foreignColumns: [reconciliationRuns.organizationId, reconciliationRuns.id],
      name: "exceptions_latest_run_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.assigneeMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "exceptions_assignee_fk",
    }),
    uniqueIndex("exceptions_stable_uidx").on(table.organizationId, table.stableKey),
    index("exceptions_org_queue_idx").on(
      table.organizationId,
      table.status,
      table.severity,
      table.createdAt,
    ),
    index("exceptions_unresolved_oldest_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} in ('open', 'assigned', 'deferred', 'proposed', 'rejected')`),
  ],
);

export const exceptionOccurrences = pgTable(
  "exception_occurrences",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: uuid("run_id").notNull(),
    exceptionId: uuid("exception_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.runId, table.exceptionId] }),
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [reconciliationRuns.organizationId, reconciliationRuns.id],
      name: "exception_occurrences_run_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.exceptionId],
      foreignColumns: [exceptions.organizationId, exceptions.id],
      name: "exception_occurrences_exception_fk",
    }),
    index("exception_occurrences_org_exception_idx").on(table.organizationId, table.exceptionId),
  ],
);

export const exceptionOccurrenceSnapshots = pgTable(
  "exception_occurrence_snapshots",
  {
    organizationId: uuid("organization_id").notNull(),
    runId: uuid("run_id").notNull(),
    exceptionId: uuid("exception_id").notNull(),
    snapshotVersion: text("snapshot_version").notNull(),
    type: text().notNull(),
    observedStatus: exceptionStatus("observed_status").notNull(),
    severity: text().notNull(),
    recordReferences: jsonb("record_references").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    currency: char({ length: 3 }),
    evidence: jsonb().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.runId, table.exceptionId] }),
    foreignKey({
      columns: [table.organizationId, table.runId, table.exceptionId],
      foreignColumns: [
        exceptionOccurrences.organizationId,
        exceptionOccurrences.runId,
        exceptionOccurrences.exceptionId,
      ],
      name: "exception_occurrence_snapshots_occurrence_fk",
    }),
    check(
      "exception_occurrence_snapshots_version_check",
      sql`${table.snapshotVersion} = 'artifact-occurrence-v1'`,
    ),
    check(
      "exception_occurrence_snapshots_type_check",
      sql`${table.type} ~ '^[a-z0-9][a-z0-9_]{0,99}$'`,
    ),
    check(
      "exception_occurrence_snapshots_severity_check",
      sql`${table.severity} in ('high', 'medium', 'low')`,
    ),
    check(
      "exception_occurrence_snapshots_references_check",
      sql`jsonb_typeof(${table.recordReferences}) = 'array'`,
    ),
    check(
      "exception_occurrence_snapshots_money_check",
      sql`(
        (${table.amountMinor} is null and ${table.currency} is null)
        or
        (${table.amountMinor} is not null and ${table.currency} ~ '^[A-Z]{3}$')
      )`,
    ),
    check(
      "exception_occurrence_snapshots_evidence_check",
      sql`jsonb_typeof(${table.evidence}) = 'object'`,
    ),
  ],
);

export const exceptionStatusEvents = pgTable(
  "exception_status_events",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: uuid("run_id").notNull(),
    exceptionId: uuid("exception_id").notNull(),
    previousStatus: exceptionStatus("previous_status"),
    nextStatus: exceptionStatus("next_status").notNull(),
    reasonCode: text("reason_code").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.runId, table.exceptionId] }),
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [reconciliationRuns.organizationId, reconciliationRuns.id],
      name: "exception_status_events_run_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.exceptionId],
      foreignColumns: [exceptions.organizationId, exceptions.id],
      name: "exception_status_events_exception_fk",
    }),
    index("exception_status_events_org_exception_idx").on(
      table.organizationId,
      table.exceptionId,
      table.occurredAt,
    ),
  ],
);

export const exceptionNotes = pgTable(
  "exception_notes",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    exceptionId: uuid("exception_id").notNull(),
    authorMembershipId: uuid("author_membership_id").notNull(),
    body: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.exceptionId],
      foreignColumns: [exceptions.organizationId, exceptions.id],
      name: "exception_notes_exception_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.authorMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: "exception_notes_author_membership_fk",
    }),
    index("exception_notes_org_exception_idx").on(
      table.organizationId,
      table.exceptionId,
      table.createdAt,
    ),
  ],
);

export const resolutionProposals = pgTable(
  "resolution_proposals",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    exceptionId: uuid("exception_id").notNull(),
    version: integer().notNull(),
    proposedBy: uuid("proposed_by"),
    proposalType: text("proposal_type").notNull(),
    reason: text().notNull(),
    evidence: jsonb().notNull(),
    status: text().notNull(),
    requiredApprovals: integer("required_approvals").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id, table.version] }),
    foreignKey({
      columns: [table.organizationId, table.exceptionId],
      foreignColumns: [exceptions.organizationId, exceptions.id],
      name: "resolution_proposals_exception_fk",
    }),
    index("resolution_proposals_org_exception_idx").on(table.organizationId, table.exceptionId),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    proposalId: uuid("proposal_id").notNull(),
    proposalVersion: integer("proposal_version").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    decision: text().notNull(),
    reason: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.proposalId, table.proposalVersion],
      foreignColumns: [
        resolutionProposals.organizationId,
        resolutionProposals.id,
        resolutionProposals.version,
      ],
      name: "approvals_proposal_fk",
    }),
    uniqueIndex("approvals_actor_proposal_uidx").on(
      table.organizationId,
      table.proposalId,
      table.proposalVersion,
      table.actorId,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text().notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    correlationId: uuid("correlation_id").notNull(),
    reason: text(),
    previousValue: jsonb("previous_value"),
    newValue: jsonb("new_value"),
    versionContext: jsonb("version_context").notNull(),
    previousEventHash: char("previous_event_hash", { length: 64 }),
    eventHash: char("event_hash", { length: 64 }).notNull(),
    hashVersion: integer("hash_version").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex("audit_events_org_event_hash_uidx").on(table.organizationId, table.eventHash),
    uniqueIndex("audit_events_org_previous_hash_uidx").on(
      table.organizationId,
      table.previousEventHash,
    ),
    uniqueIndex("audit_events_org_genesis_uidx")
      .on(table.organizationId)
      .where(sql`${table.previousEventHash} is null`),
    index("audit_events_org_time_idx").on(table.organizationId, table.occurredAt),
    index("audit_events_org_resource_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
    ),
    foreignKey({
      columns: [table.organizationId, table.previousEventHash],
      foreignColumns: [table.organizationId, table.eventHash],
      name: "audit_events_previous_hash_fk",
    }),
    check(
      "audit_events_hash_format_check",
      sql`${table.eventHash} ~ '^[a-f0-9]{64}$'
        and (${table.previousEventHash} is null or ${table.previousEventHash} ~ '^[a-f0-9]{64}$')
        and ${table.eventHash} is distinct from ${table.previousEventHash}`,
    ),
    check("audit_events_hash_version_check", sql`${table.hashVersion} in (1, 2)`),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    eventType: text("event_type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb().notNull(),
    correlationId: uuid("correlation_id").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastErrorCode: text("last_error_code"),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    executionTrackingVersion: integer("execution_tracking_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex("outbox_idempotency_uidx").on(table.organizationId, table.idempotencyKey),
    index("outbox_unpublished_idx").on(
      table.publishedAt,
      table.deadLetteredAt,
      table.nextAttemptAt,
      table.createdAt,
    ),
  ],
);

export const jobExecutions = pgTable(
  "job_executions",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    outboxEventId: uuid("outbox_event_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    eventType: text("event_type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    queueName: text("queue_name").notNull(),
    jobId: char("job_id", { length: 64 }).notNull(),
    correlationId: uuid("correlation_id").notNull(),
    status: text().notNull(),
    attempts: integer().notNull(),
    maximumAttempts: integer("maximum_attempts").notNull(),
    executionTokenSha256: char("execution_token_sha256", { length: 64 }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex("job_executions_org_outbox_uidx").on(table.organizationId, table.outboxEventId),
    uniqueIndex("job_executions_org_idempotency_uidx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("job_executions_recovery_idx").on(
      table.status,
      table.leaseExpiresAt,
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.outboxEventId],
      foreignColumns: [outboxEvents.organizationId, outboxEvents.id],
      name: "job_executions_outbox_fk",
    }),
  ],
);

export const queueRecoveryEvents = pgTable(
  "queue_recovery_events",
  {
    id: uuid().notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    recoveryRunId: uuid("recovery_run_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    eventType: text("event_type").notNull(),
    classification: text().notNull(),
    jobId: char("job_id", { length: 64 }).notNull(),
    requestedBy: text("requested_by").notNull(),
    reason: text().notNull(),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex("queue_recovery_events_run_job_uidx").on(
      table.organizationId,
      table.recoveryRunId,
      table.idempotencyKey,
    ),
    index("queue_recovery_events_org_time_idx").on(
      table.organizationId,
      table.recoveredAt,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.idempotencyKey],
      foreignColumns: [outboxEvents.organizationId, outboxEvents.idempotencyKey],
      name: "queue_recovery_events_outbox_fk",
    }),
  ],
);
