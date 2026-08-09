#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd)"
if [[ ! -f "${repo_root}/package.json" || ! -x "${repo_root}/.smithers/node_modules/.bin/smithers" && ! -f "${repo_root}/.smithers/package.json" ]]; then
  echo "Run this caller from a BB plugin root with the committed .smithers pack." >&2
  exit 2
fi

ci_tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/bb-plugin-release-gate.XXXXXX")"
mkdir -p "${ci_tmp}/bun" "${ci_tmp}/npm"
export BUN_TMPDIR="${ci_tmp}/bun"
export npm_config_cache="${ci_tmp}/npm"

if [[ "$(bb --version 2>/dev/null || true)" != "0.36.0" ]]; then
  npm install --prefix "${ci_tmp}/bb-app" --no-audit --no-fund --ignore-scripts=false bb-app@0.36.0
  export PATH="${ci_tmp}/bb-app/node_modules/.bin:${PATH}"
fi

if [[ "$(ubs --version 2>/dev/null || true)" != *"v5.3.8"* ]]; then
  curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 \
    --output "${ci_tmp}/ubs" \
    "https://github.com/Dicklesworthstone/ultimate_bug_scanner/releases/download/v5.3.8/ubs"
  printf '%s  %s\n' "4a7d7b8575a06ffa7cc017e048dd01069deed11499f9f35386a464225087b929" "${ci_tmp}/ubs" | sha256sum --check --strict -
  chmod 0755 "${ci_tmp}/ubs"
  export PATH="${ci_tmp}:${PATH}"
fi
export UBS_NO_AUTO_UPDATE=1

if [[ -f "${repo_root}/bun.lock" ]]; then
  bun install --frozen-lockfile
elif [[ -f "${repo_root}/package-lock.json" ]]; then
  npm ci --no-audit --no-fund
else
  echo "A committed bun.lock or package-lock.json is required." >&2
  exit 2
fi

bun install --cwd .smithers --frozen-lockfile
exec .smithers/node_modules/.bin/smithers workflow run \
  bb-smithers-workflows:bb-plugin-release-gate \
  --input "{\"pluginRoot\":\"${repo_root}\",\"mode\":\"verify\"}" \
  --no-post-failure \
  --no-monitor \
  --no-report
