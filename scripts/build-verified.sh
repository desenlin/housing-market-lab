#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

command -v timeout || {
  echo "build-verified.sh requires GNU timeout." >&2
  exit 69
}

vinext="${SITES_PROJECT_ROOT}/node_modules/.bin/vinext"
if [[ ! -x "${vinext}" ]]; then
  echo "vinext is unavailable. Run npm run install:ci and wait for it to finish before building." >&2
  exit 69
fi

# Stamp the deployed site with the date of the commit being built. The lab is
# California-focused, so use Pacific time rather than the runner's UTC date.
if [[ -z "${NEXT_PUBLIC_SITE_UPDATED_AT:-}" ]] && command -v git >/dev/null 2>&1; then
  NEXT_PUBLIC_SITE_UPDATED_AT="$(TZ=America/Los_Angeles git -C "${SITES_PROJECT_ROOT}" show -s --format=%cd --date=format-local:%Y-%m-%d HEAD 2>/dev/null || true)"
  export NEXT_PUBLIC_SITE_UPDATED_AT
fi

echo "Running bounded vinext build..."
timeout \
  --signal=TERM \
  --kill-after="${SITES_BUILD_KILL_AFTER:-10s}" \
  "${SITES_BUILD_TIMEOUT:-3m}" \
  "${vinext}" build
