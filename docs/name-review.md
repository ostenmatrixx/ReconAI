# Working-name collision review: ReconAI

Review date: 2026-07-27  
Conclusion: **material collision risk; keep as an internal working name only**

This is a basic public search, not legal trademark clearance, freedom-to-operate analysis, or a
substitute for counsel and jurisdiction-specific registry review.

## Findings

### Existing software and businesses

- [RECON.AI / reconai.net](https://www.reconai.net/) actively describes an enterprise AI trust
  runtime under the ReconAI name.
- [ReconAI Technology](https://www.reconaitechnology.com/) describes a financial system of record
  that organizes transactions and produces audit-ready outputs—close to this product’s domain.
- [Microsoft Marketplace: ReconAI by Confiz](https://marketplace.microsoft.com/en-us/marketplace/consulting-services/confizlimited1591780705931.reconai)
  lists intelligent document extraction and automated reconciliation.
- [getrecon.ai](https://getrecon.ai/) uses ReconAI for an AI market-research product.
- France has used
  [“Plateforme RECONAI” in a government decree](https://www.legifrance.gouv.fr/loda/id/JORFTEXT000032816811/2021-06-27)
  for a research data platform.
- Adjacent reconciliation names include ReconXi, ReconcileAI, Reconzile, ReconArt, and dharsi Recon,
  increasing confusion/search-competition risk even where marks differ.

### Package registries

- npm’s `@reconai` scope is active. The
  [`@reconai/sdk` package](https://www.npmjs.com/search?q=%40reconai%2Fsdk) belongs to the
  reconai.net trust product. This repository must not claim or publish in that scope.
- A basic web search did not establish an exact PyPI owner/availability result. Registry
  availability must be checked directly immediately before any package naming decision; availability
  alone would not establish legal safety.

### Source repositories

Public search results show ReconAI-named repositories/quickstarts associated with the trust product
and other hackathon/research projects. A future release must choose distinct repository and package
names and repeat direct GitHub/GitLab/Codeberg searches.

### Domains

`reconai.net`, `reconaitechnology.com`, and `getrecon.ai` are active. Domain availability for
`reconai.com`, country domains, and spelling variants was not established as ownership evidence in
this basic search. A registrar search close to a naming decision is required. Owning a domain would
not itself establish trademark rights.

### Trademarks

A basic public web search was inconclusive for exact registered marks and classes. The exact name’s
active commercial uses, including a closely related financial product, are already enough to require
a new candidate and qualified trademark search. Search USPTO, WIPO Global Brand Database, EUIPO,
UKIPO, and relevant customer/owner jurisdictions for exact and confusingly similar marks and
software/financial-services classes.

## Decision

- Treat ReconAI as a working code name only.
- Do not create public repositories/accounts, register domains, publish packages/images, market,
  accept contributions under the name, or assert trademark rights.
- Before public release, shortlist distinctive candidates; search software/products, npm/PyPI/
  container/package registries, GitHub/GitLab, domains/social handles, and relevant trademark
  databases; then obtain owner and qualified legal review.
- A rename must update package scopes, container/image names, OIDC clients, object prefixes,
  environment variables, docs, and migration compatibility without changing domain rule identity.

## Search limitations

Results change over time; private/unindexed/common-law use may not appear; registries are
jurisdiction/class specific; spelling/phonetic/design marks require analysis. This review records a
clear risk signal, not clearance.
