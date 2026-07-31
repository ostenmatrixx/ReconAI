# GitHub launch announcement draft

Status: draft only. Replace every bracketed field after the project name and public-release target
have completed owner and legal review.

## Primary launch post

**Title**

Introducing [CLEARED PROJECT NAME]: deterministic, open-source reconciliation for e-commerce finance
teams

**Body**

I am building **[CLEARED PROJECT NAME]**, an open-source, self-hosted reconciliation system for
e-commerce finance and operations teams.

It brings read-only Shopify and Stripe data plus accounting CSVs into one review workflow,
normalizes records with provenance, applies deterministic versioned rules, and surfaces
evidence-backed exceptions for a human to review. It does not issue refunds, change orders, or write
accounting entries back to source systems.

The repository now includes:

- integer minor-unit money with explicit currencies;
- tenant-scoped records and background jobs;
- replayable matching with versioned rules and immutable inputs;
- evidence-backed exception review and append-only audit history;
- synthetic local fixtures and a self-hosted quick start; and
- optional, disabled-by-default AI assistance that cannot approve or override a rule.

This is an early, locally verified vertical slice with passing hosted CI. It is **not
production-ready**, and there is no protected staging or production deployment evidence yet.

I would especially value feedback from:

- finance operators who reconcile commerce, payment, and accounting systems;
- engineers who have built matching, ledger-adjacent, or multi-tenant systems; and
- self-hosters interested in the deployment and connector boundaries.

Try the synthetic-data quick start, inspect the architecture, or tell me which reconciliation
workflow creates the most manual work for your team:

**[PUBLIC REPOSITORY URL]**

If the direction is useful, star or watch the repository. For questions and workflow feedback, use
**[DISCUSSIONS URL]**. Narrow, low-risk contribution tasks are labeled `good first issue`.

## Short version

I am building **[CLEARED PROJECT NAME]**, an open-source, self-hosted reconciliation system for
Shopify, Stripe, and accounting data.

It uses deterministic, versioned rules to surface evidence-backed exceptions for human review.
Source access is read-only, money uses integer minor units, tenant scope is mandatory, and optional
AI cannot approve or override a rule.

It is an early, locally verified vertical slice—not production-ready. I am looking for workflow
feedback from finance operators and reconciliation engineers:

**[PUBLIC REPOSITORY URL]**

## GitHub Discussion opener

**What is the hardest reconciliation workflow in your stack today?**

I would like the roadmap for **[CLEARED PROJECT NAME]** to reflect real operational pain rather than
generic automation ideas.

If you reconcile commerce, payment, and accounting systems, which case creates the most manual work?

- partial or split refunds;
- fees, taxes, and discounts landing at different times;
- one-to-many payment or payout relationships;
- delayed, duplicated, or reordered provider records;
- accounting CSV imports and corrections; or
- something else?

Please describe the systems involved, the evidence an operator needs to make a decision, and what a
safe read-only tool should never do. Do not share customer data, credentials, production payloads,
or sensitive financial details.

## Claim and publishing guardrails

- Keep “pre-release” and “not production-ready” prominent.
- Describe measured local or hosted evidence with its actual scope.
- Do not claim production accuracy, capacity, availability, compliance, or savings.
- Do not describe AI as the decision-maker.
- Do not imply that ReconAI writes refunds, orders, payouts, or accounting entries.
- Never include customer data, credentials, production screenshots, or provider secrets.
