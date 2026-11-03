# Dependency security record

Reviewed November 3, 2026.

## November 2 dependency audit

The scheduled audit at `d81d241` reported 19 moderate affected package entries,
tracing to two advisories newly indexed since the previous successful audit:

- [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249):
  Minimatch pattern amplification, fixed in 11.0.1. A version-scoped override
  installs the official 11.0.4 release for requests resolving below 11.0.1.
- [GHSA-wx4j-mvgx-mqwp](https://github.com/advisories/GHSA-wx4j-mvgx-mqwp):
  Satori SVG escaping. An override scoped to `vinext@1.0.0-beta.9` installs
  `@vercel/og@1.0.3` and patched `satori@0.33.5`. The existing framework, React,
  and Vite versions are preserved. Remove this override when upgrading Vinext
  to a release that includes the patched image-rendering dependency.

Satori 0.33.5 itself pins `fflate@0.7.3`. A separate override scoped to this
Satori version installs the official 0.7.5 backport for
[GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98), avoiding
the ZIP64 parsing vulnerability introduced through that dependency update.

Minimatch 11 removes the older callable CommonJS export and `makeRe` API. The
override is validated against this repository's current flat ESLint configuration,
not a claim that every optional rule configuration in the older plugins is
compatible. The security workflow now exercises the actual lint configuration
on TSX fixtures: source/generated-file selection, a clean component, and React
hooks, accessibility, and TypeScript violations. The full repository lint and
site tests must also pass. Recheck these tests when changing lint configuration;
options in older plugins that call the removed APIs need an upstream plugin fix.
Remove the Minimatch override when its consumers adopt patched versions, and
the fflate override when Satori includes a patched release itself.

These changes replace installed dependencies; they add no advisory exceptions
and do not reduce the audit threshold or exclude development dependencies.

## October 26 dependency audit

The scheduled audit found eight affected package entries covering Next.js,
Vite, Zod, fast-uri, and the Undici dependency used by Cloudflare's local tools.
Next.js and its ESLint config are updated together to 16.4.3, Vite to 8.1.6,
Zod to 4.6.7, and fast-uri to a patched 3.x release in the lockfile. The app does
not import Zod directly; its ESLint consumer supports both Zod 3 and Zod 4.

The locked Cloudflare tooling pins `miniflare@5.20261006.1-alpha`, which in turn
pins vulnerable `undici@7.29.1`. A version-scoped npm override installs the
official [Undici 7.30.1 security release](https://github.com/nodejs/undici/releases/tag/v7.30.1)
under that exact Miniflare version. This changes the installed dependency; it is
not an audit exception. Remove the override when the Cloudflare tooling is
updated to a release that includes patched Undici. No major Cloudflare downgrade
or unrelated toolchain migration is required.

## Retired braces mitigation

GitHub [withdrew GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
on October 23, 2026 because it was not a practically exploitable vulnerability.
The npm audit report no longer includes it. This is a withdrawal, not a new
patched braces release.

The local depth-limit patch, source-hash checks, postinstall hook, and temporary
exception were removed on October 26. The November 5 review deadline no longer
applies. The original patch remains recoverable in Git history. The audit still
checks all production and development dependencies, retains the raw report, and
fails for every reported moderate-or-higher finding, including this advisory if
it is reported again. Registry errors and malformed reports also fail.
