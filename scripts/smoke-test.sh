#!/usr/bin/env bash
# Post-deploy smoke test: checks a deployed ClusterWatch FROM THE OUTSIDE, like a user (and an attacker) would.
# Exit code 0 = all passed, 1 = something failed. In a pipeline, a failure here triggers a rollback.
#
# Usage:  scripts/smoke-test.sh https://xyz.trycloudflare.com
#         ADMIN_TOKEN=... scripts/smoke-test.sh https://...     (adds the authenticated SSRF checks)
#   tip:  set -a; source .env; set +a; scripts/smoke-test.sh https://...
set -uo pipefail
BASE="${1:?usage: $0 <base-url>}"; BASE="${BASE%/}"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s  (%s)\n' "$1" "$2"; fail=$((fail+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected $3, got $2"; fi; }
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
header() { curl -s -D - -o /dev/null --max-time 15 "$1" | tr -d '\r' | grep -i "^$2:" | head -1 | cut -d' ' -f2-; }
json_post() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H 'content-type: application/json' "$@"; }

echo "== Availability"
check "edge health /healthz"                    "$(status "$BASE/healthz")" 200
check "dashboard /"                             "$(status "$BASE/")" 200
check "deep link /targets/1 (SPA fallback)"     "$(status "$BASE/targets/1")" 200
check "API through the proxy /api/targets"      "$(status "$BASE/api/targets")" 200
curl -s --max-time 15 "$BASE/api/targets" | grep -q '^\[' && ok "API returns a JSON array" || bad "API returns a JSON array" "body is not JSON"

echo "== Observability"
[ -n "$(header "$BASE/api/targets" x-request-id)" ] && ok "X-Request-Id on API responses" || bad "X-Request-Id on API responses" "missing"

echo "== Security headers & caching"
check "X-Content-Type-Options"                  "$(header "$BASE/" x-content-type-options)" nosniff
check "X-Frame-Options"                         "$(header "$BASE/" x-frame-options)" DENY
check "index.html is revalidated"               "$(header "$BASE/" cache-control)" no-cache
JS=$(curl -s --max-time 15 "$BASE/" | grep -oE 'main-[A-Z0-9]+\.js' | head -1)
check "hashed bundle cached as immutable"       "$(header "$BASE/$JS" cache-control)" "public, max-age=31536000, immutable"
server=$(header "$BASE/" server)
[[ "$server" =~ [0-9] ]] && bad "server version hidden" "Server: $server" || ok "server version hidden (Server: ${server:-none})"
[ -z "$(header "$BASE/api/targets" x-powered-by)" ] && ok "no X-Powered-By" || bad "no X-Powered-By" "present"

echo "== Authentication (writes must be locked)"
check "create target without token → 401"       "$(json_post -d '{"name":"x","url":"http://example.com"}' "$BASE/api/targets")" 401
check "create target with wrong token → 401"    "$(json_post -H 'authorization: Bearer wrong' -d '{"name":"x","url":"http://example.com"}' "$BASE/api/targets")" 401
check "resolve alert without token → 401"       "$(status -X PATCH "$BASE/api/alerts/1/resolve")" 401
check "delete target without token → 401"       "$(status -X DELETE "$BASE/api/targets/1")" 401

if [ -n "${ADMIN_TOKEN:-}" ]; then
  echo "== SSRF guard (authenticated: these must be REFUSED even with a valid token)"
  AUTH=(-H "authorization: Bearer $ADMIN_TOKEN")
  check "token accepted (POST /api/session)"    "$(status -X POST "${AUTH[@]}" "$BASE/api/session")" 204
  for url in http://169.254.169.254/latest/meta-data/ http://192.168.1.1/ http://10.0.0.1/ http://127.0.0.1:5432/ \
             http://localhost:3000/ http://host.docker.internal:5433/ http://postgres:5432/ "http://[::1]/"; do
    check "refuse $url"                         "$(json_post "${AUTH[@]}" -d "{\"name\":\"ssrf-probe\",\"url\":\"$url\"}" "$BASE/api/targets")" 400
  done
else
  echo "== SSRF guard: skipped (set ADMIN_TOKEN to run the authenticated checks)"
fi

echo "== Result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
