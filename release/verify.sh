#!/usr/bin/env bash
# Release-compatibility gate (docs/REMEDIATION_PLAN.md §1).
#
#   release/verify.sh <feltkit-spec> <label> [--fk16] [--opt-in] [--with <tarball>]... [--expect-integrity <sha512-…>] [--expect-marker <text>]
#
# Builds an isolated scratch copy of this application, installs @feltdb/feltkit at <feltkit-spec>
# (a registry version such as 0.3.31, or a path to a packed .tgz) with EVERY other dependency resolved
# from the public registry (fresh install, no lockfile), records the resolved versions, and runs the
# full application suite.
#   --fk16                 also add the FK-16 probe and tests (release/fk16/)
#   --opt-in               in the scratch copy only, set authority.local.agentCallers: "executor-grants"
#                          (the application owner's explicit FK-16 opt-in; the committed app is unchanged)
#   --with <tarball>       also install this packed artifact (e.g. create-feltkit, which feltkit pins)
#   --expect-integrity     fail unless the INSTALLED @feltdb/feltkit is this exact artifact (lockfile integrity)
#   --expect-marker        fail unless the installed @feltdb/feltkit's dist contains this text
# Results go to docs/evidence/release/<label>/ (versions.txt, test.log, summary.txt).
# Tests run with the container's FELTDB_* variables unset (they point FeltKit's production mode at a
# remote FeltDB and are not part of the package combination under test).
#
# Nothing is published and the working tree is not modified (except the evidence directory).
set -euo pipefail
SPEC="${1:?feltkit spec}"; LABEL="${2:?label}"; shift 2
FK16=""; OPTIN=""; WITH=(); EXPECT_INTEGRITY=""; EXPECT_MARKER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fk16) FK16=1 ;;
    --opt-in) OPTIN=1 ;;
    --with) WITH+=("$2"); shift ;;
    --expect-integrity) EXPECT_INTEGRITY="$2"; shift ;;
    --expect-marker) EXPECT_MARKER="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/docs/evidence/release/$LABEL"
if [ -e "$OUT" ]; then echo "evidence directory $OUT exists: choose a new label (earlier runs are kept)" >&2; exit 2; fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/feltkit-release-$LABEL-XXXX")"
mkdir -p "$OUT"
CLEAN_ENV=(env -u FELTDB_URL -u FELTDB_MODE -u FELTDB_APPLICATION_ID -u FELTDB_NAMESPACE -u FELTDB_ENVIRONMENT -u FELTDB_TOKEN)

# The application exactly as committed (tracked files only), no node_modules, no lockfile, no state.
git -C "$ROOT" archive HEAD | tar -x -C "$WORK"
rm -f "$WORK/package-lock.json"
cd "$WORK"
abs() { case "$1" in /*) echo "$1" ;; *) echo "$ROOT/$1" ;; esac; }
SPEC_RESOLVED="$SPEC"; [ -f "$SPEC" ] && SPEC_RESOLVED="file:$(abs "$SPEC")"
node -e '
  const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json"));
  p.dependencies["@feltdb/feltkit"] = process.argv[1];
  for (const t of process.argv.slice(2)) {
    const name = t.replace(/^.*\//, "").replace(/-\d+\.\d+\.\d+.*\.tgz$/, "").replace(/^feltdb-/, "@feltdb/");
    p.dependencies[name] = "file:" + t;
  }
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2));' "$SPEC_RESOLVED" "${WITH[@]/#/}"

if [ -n "$FK16" ]; then
  cp "$ROOT/release/fk16/probe.ts" feltkit/zzfk16.ts
  cp "$ROOT/release/fk16/fk16.test.ts" tests/fk16.test.ts
fi
if [ -n "$OPTIN" ]; then
  grep -q '    local: true,' feltkit/app.ts || { echo "cannot apply --opt-in: authority.local is not 'true' in feltkit/app.ts" >&2; exit 2; }
  sed -i 's|    local: true,|    local: { agentCallers: "executor-grants" }, // FK-16 opt-in applied by release/verify.sh --opt-in|' feltkit/app.ts
fi

npm install --no-audit --no-fund >"$OUT/install.log" 2>&1
STATUS=0
{
  echo "label: $LABEL"
  echo "feltkit spec: $SPEC"
  for t in "${WITH[@]}"; do echo "with: $t"; done
  echo "opt-in (agentCallers: executor-grants): $([ -n "$OPTIN" ] && echo yes || echo no)"
  echo "date: $(date -u +%FT%TZ)"
  echo "registry: $(npm config get registry)"
  npm ls --depth=0 --all 2>/dev/null | grep -E "@feltdb|@authboundry|@appport|create-feltkit" || true
  echo "--- transitive"
  npm ls --all 2>/dev/null | grep -oE "(@(feltdb|authboundry|appport)/[a-z-]+|create-feltkit)@[0-9][^ ]*" | sort -u
  echo "--- @feltdb/feltkit in package-lock.json"
  node -e 'const l = JSON.parse(require("fs").readFileSync("package-lock.json")).packages["node_modules/@feltdb/feltkit"]; console.log("version", l.version); console.log("resolved", l.resolved); console.log("integrity", l.integrity)'
  echo "--- @feltdb/feltkit installed dist/runtime/local-authority.js sha256"
  sha256sum node_modules/@feltdb/feltkit/dist/runtime/local-authority.js | cut -d' ' -f1
  for t in "${WITH[@]}"; do echo "--- $(basename "$t") sha512"; echo "sha512-$(openssl dgst -sha512 -binary "$t" | base64 -w0)"; done
  echo "--- @authboundry/local exports"
  node --input-type=module -e 'import * as l from "@authboundry/local"; console.log(Object.keys(l).join(", "));' || true
  echo "registerAgent references in @authboundry/local: $(grep -c "registerAgent" node_modules/@authboundry/local/index.js || true)"
} >"$OUT/versions.txt" 2>&1

# Artifact identity: what is installed must be what was asked for.
INSTALLED_INTEGRITY="$(node -p 'JSON.parse(require("fs").readFileSync("package-lock.json")).packages["node_modules/@feltdb/feltkit"].integrity')"
if [ -n "$EXPECT_INTEGRITY" ] && [ "$INSTALLED_INTEGRITY" != "$EXPECT_INTEGRITY" ]; then
  echo "ARTIFACT MISMATCH: installed @feltdb/feltkit integrity $INSTALLED_INTEGRITY, expected $EXPECT_INTEGRITY" | tee -a "$OUT/versions.txt" >&2; STATUS=3
fi
if [ -n "$EXPECT_MARKER" ] && ! grep -rqF "$EXPECT_MARKER" node_modules/@feltdb/feltkit/dist; then
  echo "ARTIFACT MISMATCH: installed @feltdb/feltkit dist does not contain \"$EXPECT_MARKER\"" | tee -a "$OUT/versions.txt" >&2; STATUS=3
fi
if [ "$STATUS" -ne 0 ]; then echo "exit: $STATUS (artifact identity)" >"$OUT/summary.txt"; cat "$OUT/summary.txt"; rm -rf "$WORK"; exit $STATUS; fi
[ -n "$EXPECT_INTEGRITY" ] && echo "artifact identity: installed integrity matches the expected tarball" >>"$OUT/versions.txt"
[ -n "$EXPECT_MARKER" ] && echo "artifact identity: installed dist contains \"$EXPECT_MARKER\"" >>"$OUT/versions.txt"

"${CLEAN_ENV[@]}" npx feltkit codegen >/dev/null
set +e
"${CLEAN_ENV[@]}" npx feltkit test >"$OUT/test.log" 2>&1
STATUS=$?
set -e
{
  echo "exit: $STATUS"
  grep -E "^# (tests|pass|fail|skipped|duration_ms)" "$OUT/test.log"
  grep -E "^not ok" "$OUT/test.log" || true
} >"$OUT/summary.txt"
cat "$OUT/summary.txt"
rm -rf "$WORK"
exit $STATUS
