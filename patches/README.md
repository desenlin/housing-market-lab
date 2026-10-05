# Temporary braces depth-limit mitigation

Reviewed October 5, 2026; exception expires **November 5, 2026 (00:00 UTC)**.

The October 5 dependency audit found [GHSA-vfj7-8cjw-p6xm /
CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) in
`braces@3.0.3`. Excessively nested brace patterns can exhaust the JavaScript
stack. There is no official patched release at the time of this change.
`npm audit fix --force` proposes major downgrades of Next's ESLint config and
Vinext, which would not be a compatible repair of the current tooling.

## Scope and mitigation

The eight audit entries represent one underlying advisory propagated through
`micromatch`, `fast-glob`, Next's ESLint plugin/config, and Vinext's CommonJS and
dynamic-import plugins. The locked dependency paths are development-only. The
public GitHub Pages deployment serves a static export; it does not run this Node
package for visitor requests. This limits exposure but does not remove the need
to protect the build tools.

`braces-3.0.3-depth.patch` backports only the five `lib/` file changes from
[upstream PR #72](https://github.com/micromatch/braces/pull/72), reviewed at commit
`28d440b5dd449dbf1fe6f3506cf94ecca4d02660`, to the published 3.0.3 source. The PR
is not an official release. No unrelated unreleased parser changes are included.
The patch caps brace and parenthesis nesting at 100, bounds recursive processing
of caller-supplied syntax trees, preserves stringify escaping behavior, and
rejects cyclic parent chains during expansion. The upstream code remains under
its original MIT license; the dependency's license and package identity are
unchanged. This is a depth/recursion mitigation, not a general guarantee against
all resource-exhaustion inputs.

The root `postinstall` applies the patch. `scripts/patch-braces.mjs` verifies
SHA-256 hashes of all executable package files before and after patching, accepts
only the exact reviewed version and install location, and is safe to rerun.
An unexpected source, additional copy, production path, or partial patch fails.
Use normal `npm ci` / `npm run install:ci`; if installing with `--ignore-scripts`,
run `npm run postinstall` explicitly before using build tools.

## Audit behavior and tests

`npm run audit:security` verifies the installed patch, audits the **entire**
lockfile including development dependencies, and retains `security-audit.json`
without filtering its contents. Only this exact high-severity advisory and its
development-only transitive effects receive a temporary warning. New advisories
on any of the same packages still fail, as do other moderate-or-higher findings,
unexpected audit output, registry errors, missing patches, and expiration.
The security workflow installs dependencies without lifecycle scripts, explicitly
applies the patch, runs regression tests, then audits and uploads the raw report.

Regression coverage includes ordinary brace/glob output, the 100/101 nesting
boundary, adversarial strings and direct syntax trees, fractional depth options,
parent cycles, unchanged escaping, idempotent patch verification, and audit
failure cases. The published 3.0.3 upstream test suite and the repository's
lint/build/tests are also checked when introducing this backport.

## Retirement

### Release and alternatives review: October 5, 2026

The npm registry still lists `braces@3.0.3` as latest, and the advisory lists no
patched version. PR #72 is closed without being merged; it must not be described
as an accepted upstream fix or a promised release. The latest checked releases
of `micromatch` (4.0.8), `fast-glob` (3.3.3), `eslint-config-next` (16.3.8), and
`vinext` (1.0.1) do not remove the affected dependency chain. Upgrading Vinext from
the locked beta to 1.0.1 would still retain its CommonJS/dynamic-import glob path.

This is also affecting other projects. RummerLab's
[merged PR #219](https://github.com/RummerLab/rummerlab-website/pull/219) uses a
local depth-limit patch and a scoped scanner policy while awaiting a release.
Tailwind's [open PR #20541](https://github.com/tailwindlabs/tailwindcss/pull/20541)
proposes replacing the affected dependency chain for v3; it is not a released
fix. DeepAgents' [open PR #925](https://github.com/langchain-ai/deepagentsjs/pull/925)
proposes dependency replacement plus input limits and documents compatibility
differences between glob libraries.

A blanket `fast-glob` override to `tinyglobby` is not compatible with this tree:
Next's ESLint plugin uses `globSync`, but `vite-plugin-dynamic-import@1.6.0` calls
the default export's `.sync` method, which `tinyglobby@0.2.17` does not provide.
Removing the entire chain therefore requires compatible upstream changes or an
explicitly maintained adapter/fork with glob behavior and build tests. Retain
the verified local mitigation for now rather than silently substituting an
incompatible package.

November 5 is our review deadline, not an upstream release date. If no official
fix exists then, reassess the advisory, dependency paths, exposure and regression
tests before deliberately renewing the narrow exception, or migrate away from
the affected chain. The patch continues to apply after expiry; the audit fails
to make that review visible.

### Removing the temporary mitigation

At the next dependency update, check the advisory and official npm release.
When an official compatible fix is available, update the lockfile, remove this
patch, its scripts/tests/fixture, the root `postinstall`, and the temporary audit
exception. Restore the ordinary full-lockfile `npm audit` command and run the
build and regression checks. A changed version fails the pin check deliberately
so an update cannot silently retain an obsolete exception. Do not extend the
expiry automatically or hide the advisory with a package rename.
