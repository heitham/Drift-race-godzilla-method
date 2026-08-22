#!/usr/bin/env bash
#
# Reset the CMS to the pristine benchmark baseline, between runs.
#
#   stop services -> restore database -> restart services -> verify
#
# Postgres refuses to drop a database with live connections, so the CMS dev
# server and its worker must come down first; this script sequences that
# safely and refuses to leave the system half-restored.
#
# Usage: npm run reset          (or: bash scripts/reset-baseline.sh)

set -euo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Load .env.local the same way the TypeScript harness does. Parameterising the
# hard-coded paths made this script depend on the environment without teaching
# it where the environment lives, so it failed on the first run after that
# change. Parsed rather than sourced: values contain spaces and would otherwise
# be executed.
if [ -f "$BENCH_DIR/.env.local" ]; then
  while IFS='=' read -r k v; do
    [ -z "${k:-}" ] && continue
    case "$k" in \#*) continue ;; esac
    v="${v%\"}"; v="${v#\"}"
    export "$k=$v"
  done < "$BENCH_DIR/.env.local"
fi

CMS_DIR="${CMS_REPO:?CMS_REPO is not set — add it to .env.local (see .env.example)}"
DB_URL="${DATABASE_URL:-postgres://localhost:5432/cms_dev}"
DUMP="$BENCH_DIR/baseline/cms_dev.baseline.dump"
SITE_ID="32114acb-ccbe-44e4-96d4-64fa594284e2"
EXPECTED_PAGES=30
PORT=3001

eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true

say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
die()  { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

# --- preflight: never destroy a database without a restorable dump ----------
step "checking the dump"
[ -f "$DUMP" ] || die "no baseline dump at $DUMP (run: npm run baseline:dump)"
EXPECTED_SHA="$(python3 -c "
import json;print(json.load(open('$BENCH_DIR/benchmarks/godzilla-docs/benchmark.config.json'))['baseline']['dbDumpSha256'])")"
ACTUAL_SHA="$(shasum -a 256 "$DUMP" | cut -d' ' -f1)"
[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] \
  || die "dump sha mismatch — expected ${EXPECTED_SHA:0:12}, got ${ACTUAL_SHA:0:12}.
  The dump is not the one this benchmark was frozen against. Restoring it would
  silently change the baseline for every run. Investigate before proceeding."
say "dump OK  ${ACTUAL_SHA:0:12}"

# --- stop ------------------------------------------------------------------
step "stopping CMS services"
pkill -f "src/worker.ts" 2>/dev/null || true
pkill -f "next dev"      2>/dev/null || true
pkill -f "next-server"   2>/dev/null || true
for _ in $(seq 1 15); do
  lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 1
done
lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && die "port $PORT still held; stop it manually"
say "stopped"

# --- restore ---------------------------------------------------------------
step "restoring database"
# Terminate stragglers (an editor or psql session also blocks the drop).
psql -d postgres -tAc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname='cms_dev' AND pid<>pg_backend_pid();" >/dev/null 2>&1 || true
dropdb --if-exists cms_dev || die "dropdb failed"
createdb cms_dev          || die "createdb failed"
pg_restore -d "$DB_URL" "$DUMP" 2>&1 | grep -iE "^pg_restore: error" && die "restore reported errors" || true
say "restored"

# --- re-apply schema migrations --------------------------------------------
# The dump is frozen at the benchmark's content baseline, but the CMS SCHEMA
# moves under active development — migration 0047 added
# change_sets.reviewed_by_api_key_id, without which every automated approval
# fails. Restoring the dump therefore rewinds the schema too, and the run would
# break on the first review with a column-not-found error that looks nothing
# like its cause. Migrations are idempotent (drizzle tracks what has run), so
# this is safe when there is nothing new to apply.
step "applying schema migrations"
cd "$CMS_DIR"
DATABASE_URL="$DB_URL" pnpm db:migrate >/tmp/cms-migrate.log 2>&1 \
  || die "migrations failed — see /tmp/cms-migrate.log"
say "schema current"

# --- re-seed the benchmark API key -----------------------------------------
# The baseline dump predates the agent key, so every restore wipes it and the
# governed arm loses its MCP auth. Re-seeding here keeps reset self-healing
# rather than requiring a trip through the admin UI between every run.
# Keys are stored as plain sha256(token), so the row can be reconstructed.
step "re-seeding benchmark API key"
RIFT_KEY="$(grep -E '^RIFT_API_KEY=' "$BENCH_DIR/.env.local" | cut -d= -f2- | tr -d '"')"
[ -n "$RIFT_KEY" ] || die "RIFT_API_KEY missing from .env.local"
KEY_HASH="$(printf '%s' "$RIFT_KEY" | shasum -a 256 | cut -d' ' -f1)"
ADMIN_ID="$(psql "$DB_URL" -tAc "SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1;")"
psql "$DB_URL" -tAc "
  INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, role, created_by)
  VALUES (gen_random_uuid(), 'benchmark-agent', '$KEY_HASH', '${RIFT_KEY:0:12}',
          '$ADMIN_ID', 'agent', '$ADMIN_ID')
  ON CONFLICT DO NOTHING;" >/dev/null || die "could not seed API key"
say "seeded (agent role)"

# The harness also needs an ADMIN key, kept strictly separate from the agent
# key above. The model under test only ever sees the agent key and therefore
# can never approve its own work — that ceiling is the governance model the
# benchmark exists to measure. The admin key belongs to the harness, which
# plays the content team's reviewer between operations (methodology §4.5).
RIFT_ADMIN="$(grep -E '^RIFT_ADMIN_KEY=' "$BENCH_DIR/.env.local" | cut -d= -f2- | tr -d '"')"
if [ -n "$RIFT_ADMIN" ]; then
  ADMIN_HASH="$(printf '%s' "$RIFT_ADMIN" | shasum -a 256 | cut -d' ' -f1)"
  psql "$DB_URL" -tAc "
    INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, role, created_by)
    VALUES (gen_random_uuid(), 'benchmark-reviewer', '$ADMIN_HASH', '${RIFT_ADMIN:0:12}',
            '$ADMIN_ID', 'admin', '$ADMIN_ID')
    ON CONFLICT DO NOTHING;" >/dev/null || die "could not seed admin API key"
  say "seeded (admin role, reviewer)"
else
  say "no RIFT_ADMIN_KEY set — governed runs will refuse to start"
fi

# --- restart ---------------------------------------------------------------
step "starting CMS on :$PORT"
cd "$CMS_DIR"
DATABASE_URL="$DB_URL" \
REDIS_URL=redis://localhost:6379 \
SESSION_SECRET=cms-dev-secret-change-in-production \
  nohup pnpm dev --port $PORT >/tmp/cms-dev-$PORT.log 2>&1 &
disown || true

for _ in $(seq 1 45); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT" --max-time 2 || true)"
  [ "$code" != "000" ] && break
  sleep 2
done
[ "${code:-000}" = "000" ] && die "CMS did not come up — see /tmp/cms-dev-$PORT.log"
say "CMS up (http $code)"

step "starting publish worker"
# The worker needs the full env file (CMS_MASTER_KEY decrypts the deploy key);
# without it every publish fails and snapshots never land.
cd "$CMS_DIR/apps/web"
# Parse rather than `source`: the file contains unquoted values with spaces
# (DATA_DIR=.../Claude CMS Build/data), which `source` executes as a command.
while IFS='=' read -r k v; do
  [ -z "${k:-}" ] && continue
  case "$k" in \#*) continue ;; esac
  v="${v%\"}"; v="${v#\"}"
  export "$k=$v"
done < ./.env.local
[ -n "${CMS_MASTER_KEY:-}" ] || die "CMS_MASTER_KEY missing from apps/web/.env.local — publishes would fail to decrypt the deploy key"

WORKER_MODE=true nohup ./node_modules/.bin/tsx src/worker.ts >/tmp/cms-worker.log 2>&1 &
disown || true

for _ in $(seq 1 20); do
  grep -q "all workers running" /tmp/cms-worker.log 2>/dev/null && break
  sleep 1
done
grep -q "all workers running" /tmp/cms-worker.log 2>/dev/null \
  || die "worker did not start — see /tmp/cms-worker.log"
say "worker up"

# --- rebuild the link graph -------------------------------------------------
# The baseline dump predates FR-LK-002, when only the (cms) UI server actions
# maintained link_edges — every MCP write left the graph untouched, so the
# baseline restores with effectively zero edges across its 30 pages. An empty
# graph silently disables the governed arm's rename repointing and broken-link
# reporting: the run would measure a crippled CMS and report the result as the
# substrate's ceiling. Idempotent, so this is safe on every reset.
step "rebuilding link graph"
cd "$CMS_DIR/apps/web"
DATABASE_URL="$DB_URL" ./node_modules/.bin/tsx scripts/backfill-link-edges.ts --site "$SITE_ID" \
  >/tmp/cms-backfill.log 2>&1 || die "link-edge backfill failed — see /tmp/cms-backfill.log"
EDGES="$(psql "$DB_URL" -tAc "
  SELECT count(*) FROM link_edges le
  JOIN content_placements cp ON cp.item_id = le.from_item_id
  WHERE cp.site_id = '$SITE_ID';")"
say "link edges     $EDGES"
[ "$EDGES" -gt 100 ] || die "link graph looks empty ($EDGES edges) — governed rename-safety would be inert"

# --- verify ----------------------------------------------------------------
step "verifying baseline"
PAGES="$(psql "$DB_URL" -tAc "
  SELECT count(*) FROM content_placements cp
  JOIN content_items ci ON ci.id = cp.item_id
  WHERE cp.site_id = '$SITE_ID' AND ci.workflow_state = 'public';")"
STAGING="$(psql "$DB_URL" -tAc "
  SELECT count(*) FROM content_placements cp
  JOIN content_items ci ON ci.id = cp.item_id
  WHERE cp.site_id = '$SITE_ID' AND ci.workflow_state = 'staging';")"
BRANCH="$(psql "$DB_URL" -tAc "SELECT git_staging_branch FROM sites WHERE id='$SITE_ID';")"

say "public pages    $PAGES (expected $EXPECTED_PAGES)"
say "staging items   $STAGING (expected 0)"
say "staging branch  $BRANCH"

[ "$PAGES" = "$EXPECTED_PAGES" ] || die "page count mismatch — baseline is not clean"
[ "$STAGING" = "0" ]             || die "leftover staging items — baseline is not clean"

printf '\nbaseline clean — ready to run\n'
