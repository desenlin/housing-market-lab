# Dependency security record

Reviewed October 26, 2026.

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
