# Verification artifacts

This directory contains bounded, reviewable evidence that supports claims made in the repository.
Evidence is part of the source publication boundary because documentation links must continue to
resolve after a clone.

Only synthetic, sandbox, or local control-test evidence belongs here. Never add credentials,
provider tokens, raw customer or production payloads, private keys, personal home-directory paths,
or unrestricted logs. Prefer structured JSON with explicit scope and limitations. Dated Markdown
is reserved for a bounded consolidated transcript. Generated release archives, images, logs, and
unreviewed runtime output remain ignored.

Before review:

```sh
pnpm source:check
pnpm evidence:check
pnpm secret:scan
```

The validator enforces filename, size, JSON parsing, documentation-link, Git-ignore, and local-path
redaction rules. Evidence records are historical; supersede them with a new dated file instead of
silently rewriting a claimed result. `sbom.cdx.json` is the bounded generated application SBOM and
is replaced only by the documented SBOM command.
