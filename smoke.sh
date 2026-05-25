#!/usr/bin/env bash
#
# Smoke-test the W3C trace context Worker.
#
# Usage:
#   ./smoke.sh                    # tests against http://localhost:8787
#   BASE_URL=https://... ./smoke.sh
#
# Run `npm run dev` in another terminal first.

# SC2016: predicate strings below intentionally use single quotes so that
# $status / $traceparent / $INBOUND_* expand later, inside `eval` in run_case,
# after the variables have actually been set.
# shellcheck disable=SC2016

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
INBOUND_TRACE_ID="0af7651916cd43dd8448eb211c80319c"
INBOUND_TRACEPARENT="00-${INBOUND_TRACE_ID}-b7ad6b7169203331-01"

pass=0
fail=0

# Run one test case.
#
#   $1     — human label
#   $2     — predicate: bash code that runs with $status, $body, and
#            $traceparent set, returning 0 on pass.
#   $3...  — extra curl args (passed positionally, quoting preserved)
run_case() {
    local label="$1"
    local predicate="$2"
    shift 2

    echo
    echo "── ${label}"

    local body_file
    body_file=$(mktemp)
    # shellcheck disable=SC2064  # we want $body_file expanded now, not on trap
    trap "rm -f '${body_file}'" RETURN

    local response
    response=$(curl -sS -D - -o "${body_file}" "$@" "${BASE_URL}/")
    local body
    body=$(cat "${body_file}")

    local status
    status=$(awk 'NR==1 {print $2}' <<<"${response}")
    local traceparent
    traceparent=$(awk 'BEGIN{IGNORECASE=1} /^traceparent:/ {print $2}' <<<"${response}" | tr -d '\r')

    echo "   status:      ${status}"
    echo "   traceparent: ${traceparent}"
    echo "   body:        ${body}"

    # The predicate references $status / $traceparent which are in scope here.
    if eval "${predicate}"; then
        echo "   ✓ pass"
        pass=$((pass + 1))
    else
        echo "   ✗ fail"
        fail=$((fail + 1))
    fi
}

echo "Testing ${BASE_URL}"

# 1. No inbound traceparent — server should mint a fresh one.
run_case "fresh trace (no inbound traceparent)" \
    '[[ "${status}" == "200" ]] \
        && [[ "${traceparent}" =~ ^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$ ]] \
        && [[ "${traceparent}" != *"${INBOUND_TRACE_ID}"* ]]'

# 2. Valid inbound traceparent — server should continue the same trace_id
#    but with a new span (parent) id.
run_case "continue inbound trace" \
    '[[ "${status}" == "200" ]] \
        && [[ "${traceparent}" == "00-${INBOUND_TRACE_ID}-"* ]] \
        && [[ "${traceparent}" != "${INBOUND_TRACEPARENT}" ]]' \
    -H "traceparent: ${INBOUND_TRACEPARENT}"

# 3. Malformed inbound traceparent — server should ignore and mint fresh.
run_case "ignore malformed inbound traceparent" \
    '[[ "${status}" == "200" ]] \
        && [[ "${traceparent}" =~ ^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$ ]]' \
    -H "traceparent: not-a-real-traceparent"

echo
echo "──────────────────────────"
echo "  passed: ${pass}"
echo "  failed: ${fail}"

if [[ "${fail}" -gt 0 ]]; then
    exit 1
fi
