import { Construction, ShieldCheck } from "lucide-react";
import { notFound } from "next/navigation";

import { AuditHistory } from "../../../components/audit-history";
import { ConnectorHealth } from "../../../components/connector-health";
import { OrganizationMembers } from "../../../components/organization-members";
import { OrganizationProfileSettings } from "../../../components/organization-profile-settings";
import { PrivacyRequestOperations } from "../../../components/privacy-request-operations";
import { ReconciliationRuns } from "../../../components/reconciliation-runs";
import { RetentionPolicySettings } from "../../../components/retention-policy-settings";
import { ReviewPolicySettings } from "../../../components/review-policy-settings";
import { SupportAccessGrants } from "../../../components/support-access-grants";

const sections: Readonly<Record<string, { readonly title: string; readonly description: string }>> =
  {
    runs: {
      title: "Reconciliation runs",
      description:
        "Run history and replay controls will show immutable snapshots, versions, counts, errors, and correlation evidence.",
    },
    connectors: {
      title: "Connector health",
      description:
        "Backfill, webhook, scheduled repair, freshness, rate, and action-required states will appear here.",
    },
    audit: {
      title: "Audit history",
      description:
        "Append-only actor, action, resource, reason, version, correlation, and approval-chain events will appear here.",
    },
    rules: {
      title: "Rules & tolerances",
      description:
        "Versioned, bounded organization policy will be visible here. Currency conversion remains disabled in V1.",
    },
    security: {
      title: "Security controls",
      description:
        "Session, MFA capability, access review, connector credential, retention, and support-access controls will appear here.",
    },
    settings: {
      title: "Organization settings",
      description:
        "Membership, explicit permissions, retention, and organization-level AI disablement will appear here.",
    },
  };

export default async function SectionPage({
  params,
}: {
  readonly params: Promise<{ readonly section: string }>;
}) {
  const { section } = await params;
  const item = sections[section];
  if (!item) notFound();
  if (section === "connectors") return <ConnectorHealth />;
  if (section === "settings")
    return (
      <>
        <OrganizationProfileSettings />
        <OrganizationMembers showPageHeading={false} />
      </>
    );
  if (section === "audit") return <AuditHistory />;
  if (section === "runs") return <ReconciliationRuns />;
  if (section === "rules") return <ReviewPolicySettings />;
  if (section === "security")
    return (
      <>
        <RetentionPolicySettings />
        <PrivacyRequestOperations />
        <SupportAccessGrants />
      </>
    );
  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Controlled capability</p>
          <h1>{item.title}</h1>
          <p>{item.description}</p>
        </div>
      </section>
      <div className="state-panel pending-panel">
        <Construction aria-hidden="true" size={23} />
        <div>
          <strong>Not yet implemented</strong>
          <p>
            This state is intentionally honest. The surface will not display fabricated health,
            audit, policy, or security data before its tenant-authorized backend exists.
          </p>
        </div>
        <ShieldCheck aria-hidden="true" size={20} />
      </div>
    </>
  );
}
