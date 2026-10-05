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

At the next dependency update, check the advisory and official npm release.
When an official compatible fix is available, update the lockfile, remove this
patch, its scripts/tests/fixture, the root `postinstall`, and the temporary audit
exception. Restore the ordinary full-lockfile `npm audit` command and run the
build and regression checks. A changed version fails the pin check deliberately
so an update cannot silently retain an obsolete exception. Do not extend the
expiry automatically or hide the advisory with a package rename.
