#!/usr/bin/env bash
# Release-compatibility gate (docs/REMEDIATION_PLAN.md §1).
#
#   release/verify.sh <feltkit-spec> <label> [--fk16]
#
# Builds an isolated scratch copy of this application, installs @feltdb/feltkit at <feltkit-spec>
# (a registry version such as 0.3.31, or a path to a .tgz) with EVERY other dependency resolved
# from the public registry (fresh install, no lockfile), records the resolved versions, and runs the
# full application suite. With --fk16 it also adds the FK-16 probe and tests (release/fk16/).
# Results go to docs/evidence/release/<label>/ (versions.txt, test.log, summary.txt).
#
# Nothing is published and the working tree is not modified (except the evidence directory).
set -euo pipefail
SPEC="${1:?feltkit spec}"; LABEL="${2:?label}"; FK16="${3:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/docs/evidence/release/$LABEL"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/feltkit-release-$LABEL-XXXX")"
mkdir -p "$OUT"

# The application exactly as committed (tracked files only), no node_modules, no lockfile, no state.
git -C "$ROOT" archive HEAD | tar -x -C "$WORK"
rm -f "$WORK/package-lock.json"
cd "$WORK"
node -e '
  const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json"));
  p.dependencies["@feltdb/feltkit"] = process.argv[1];
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2));' "$SPEC"

if [ "$FK16" = "--fk16" ]; then
  cp "$ROOT/release/fk16/probe.ts" feltkit/zzfk16.ts
  cp "$ROOT/release/fk16/fk16.test.ts" tests/fk16.test.ts
fi

npm install --no-audit --no-fund >"$OUT/install.log" 2>&1
{
  echo "label: $LABEL"
  echo "feltkit spec: $SPEC"
  echo "date: $(date -u +%FT%TZ)"
  echo "registry: $(npm config get registry)"
  npm ls --depth=0 --all 2>/dev/null | grep -E "@feltdb|@authboundry|@appport" || true
  echo "--- transitive"
  npm ls --all 2>/dev/null | grep -oE "@(feltdb|authboundry|appport)/[a-z-]+@[0-9][^ ]*" | sort -u
  echo "--- @feltdb/feltkit resolved from"
  node -p 'require("./node_modules/@feltdb/feltkit/package.json")._resolved || "(see package-lock.json)"'
  node -p 'JSON.parse(require("fs").readFileSync("package-lock.json")).packages["node_modules/@feltdb/feltkit"].resolved'
  echo "--- @authboundry/local exports registerAgent?"
  node --input-type=module -e 'import * as l from "@authboundry/local"; console.log(Object.keys(l).join(", "));' || true
  grep -c "registerAgent" node_modules/@authboundry/local/index.js || true
} >"$OUT/versions.txt" 2>&1

npx feltkit codegen >/dev/null
set +e
npx feltkit test >"$OUT/test.log" 2>&1
STATUS=$?
set -e
{
  echo "exit: $STATUS"
  grep -E "^# (tests|pass|fail|duration_ms)" "$OUT/test.log"
  grep -E "^not ok" "$OUT/test.log" || true
} >"$OUT/summary.txt"
cat "$OUT/summary.txt"
rm -rf "$WORK"
exit $STATUS
