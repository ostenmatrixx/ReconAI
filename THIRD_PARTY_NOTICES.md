# Third-party notices

ReconAI is licensed under Apache-2.0. Its production dependency graph also includes software and
data under compatible or separately reviewed licenses. The authoritative package-by-package
inventory is `config/production-license-inventory.json`. It covers the lockfile's complete
production and optional graph across supported platforms and is regenerated with
`pnpm license:inventory` after dependency review. `pnpm license:check` binds it to the complete
lockfile and rejects missing packages or licenses outside the exact-expression allowlist in
`scripts/production-license-policy.mjs`.

## Attribution and reciprocal-license notes

- Manrope and IBM Plex Mono font files are distributed under the SIL Open Font License 1.1.
- `caniuse-lite` contains browser-compatibility data distributed under CC BY 4.0. Its project and
  attribution information are available at <https://github.com/browserslist/caniuse-lite>.
- Sharp's platform packages may redistribute libvips binaries under LGPL-3.0-or-later. Libvips
  source and license information are available at <https://github.com/libvips/libvips>. Container
  distributors must preserve the corresponding notices and provide the relinking/source rights
  required by that license.

This file is not a substitute for the license texts shipped inside dependency packages. Release
artifacts must retain those package license files and the generated SBOM.
