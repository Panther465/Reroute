#!/usr/bin/env bash
# Everything CI checks that runs without the stack, on this machine, in one go (a few minutes):
#   api     Reroute's API: lint, tests (the whole API, against a throwaway PostGIS) and its OpenAPI file
#   raasta  Raasta's API: the same
#   web     the web app (and the Android app's own pieces): type check and tests
# The three run side by side; the summary names what failed and shows the end of its log.
#
#   scripts/check.sh            all three
#   scripts/check.sh web api    only those
#
# Needs bash 4 or later (Git Bash on Windows), Docker for the throwaway database, Python with each API's dev
# dependencies, and pnpm. Each API uses its own .venv when there is one (backend/.venv, raasta/.venv); otherwise
# BACKEND_PYTHON / RAASTA_PYTHON, or python. CHECK_PG_PORT picks the database's port (default 57998; some Windows
# ports near 56000 are reserved). The browser tests (pnpm e2e), Postman and the Android tests need the running
# stack: see the README, "Tests".
set -u
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Paths for Python and pytest: on Windows (Git Bash) /d/… and /tmp/… mean nothing to them, so D:/… instead.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
NROOT="$(native "$ROOT")"
# Rico is locked in the repository (frontend/rico/): opened with RICO_KEY from .env, as CI does; without it,
# everything is checked without him.
node "$ROOT/frontend/rico/lock.mjs" unlock --quiet
PORT="${CHECK_PG_PORT:-57998}"
DB="reroute-check-pg-$$"
LOGS="$(mktemp -d)"
WANT="${*:-api raasta web}"

python_for() {
  local dir="$1" override="$2" p
  if [ -n "$override" ]; then echo "$override" && return; fi
  for p in "$ROOT/$dir/.venv/Scripts/python.exe" "$ROOT/$dir/.venv/bin/python"; do
    if [ -x "$p" ]; then echo "$p" && return; fi
  done
  command -v python3 || command -v python
}

# Made as CI makes it (UTF-8, LF, a final newline), and compared ignoring a Windows checkout's CRLF.
openapi_matches() {
  local py="$1" name="$2" out
  out="$(mktemp)"
  APP_ENV=test "$py" -c "import json, sys; from pathlib import Path; from app.main import app; Path(sys.argv[1]).write_text(json.dumps(app.openapi(), indent=2, ensure_ascii=False) + chr(10), encoding='utf-8', newline=chr(10))" "$(native "$out")" &&
    diff -u --strip-trailing-cr "$ROOT/shared/contracts/$name.openapi.json" "$out" && echo "OpenAPI file matches the code."
}

api() {
  local py
  py="$(python_for backend "${BACKEND_PYTHON:-}")"
  cd "$ROOT/backend" &&
    "$py" -m ruff check app tests && "$py" -m ruff format --check app tests &&
    TEST_DATABASE_URL="postgresql+psycopg://postgres:postgres@127.0.0.1:$PORT/reroute" EXAMPLES_DIR="$NROOT/examples" APP_ENV=test \
      "$py" -m pytest -q -p no:cacheprovider -o addopts="" &&
    openapi_matches "$py" reroute
}

raasta() {
  local py
  py="$(python_for raasta "${RAASTA_PYTHON:-}")"
  cd "$ROOT/raasta" &&
    "$py" -m ruff check app tests && "$py" -m ruff format --check app tests &&
    TEST_DATABASE_URL="postgresql+psycopg://postgres:postgres@127.0.0.1:$PORT/raasta_test" EXAMPLES_DIR="$NROOT/examples/bengaluru" APP_ENV=test \
      "$py" -m pytest -q -p no:cacheprovider -o addopts="" &&
    openapi_matches "$py" raasta
}

web() {
  # A few workers: beside the API tests, more only fight over the processor and time out.
  cd "$ROOT/frontend" && pnpm -s typecheck && pnpm exec vitest run --maxWorkers=3
}

for part in $WANT; do
  case "$part" in
    api | raasta | web) ;;
    *) echo "Unknown part: $part (api, raasta or web)" && exit 2 ;;
  esac
done

trap 'docker rm -f "$DB" >/dev/null 2>&1' EXIT
case " $WANT " in
  *" api "* | *" raasta "*)
    echo "Starting a throwaway PostGIS on 127.0.0.1:$PORT…"
    if ! docker run -d --rm --name "$DB" -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=reroute \
      -p "127.0.0.1:$PORT:5432" postgis/postgis:16-3.4 >/dev/null; then
      echo "Docker couldn't start the database: is Docker running, and port $PORT free (CHECK_PG_PORT)?" && exit 1
    fi
    # It answers over TCP only once its first start, which installs PostGIS, is over.
    for _ in $(seq 1 90); do
      docker exec "$DB" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
      sleep 1
    done
    docker exec "$DB" psql -h 127.0.0.1 -U postgres -qc "CREATE DATABASE raasta_test" >/dev/null || { echo "The database didn't come up." && exit 1; }
    ;;
esac

declare -A PIDS
for part in $WANT; do
  echo "Running $part…"
  (
    start=$SECONDS
    "$part" >"$LOGS/$part.log" 2>&1
    rc=$?
    echo $((SECONDS - start)) >"$LOGS/$part.secs"
    exit $rc
  ) &
  PIDS[$part]=$!
done

failed=()
echo
for part in $WANT; do
  if wait "${PIDS[$part]}"; then status=pass; else status=FAIL && failed+=("$part"); fi
  printf '  %s  %-7s %ss\n' "$status" "$part" "$(cat "$LOGS/$part.secs" 2>/dev/null || echo '?')"
done
for part in "${failed[@]}"; do
  echo
  echo "---- $part: the end of its log ($LOGS/$part.log) ----"
  tail -n 30 "$LOGS/$part.log"
done
[ "${#failed[@]}" -eq 0 ] || exit 1
echo
echo "All passed."
