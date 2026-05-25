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

if ! command -v jq >/dev/null 2>&1; then
	echo "jq is required to parse the Worker JSON response" >&2
	exit 1
fi

pass=0
fail=0

# Run one test case.
#
#   $1     — human label
#   $2     — required Worker predicate: bash code that runs with $status,
#            $body, and $traceparent set, returning 0 on pass. If the live
#            upstream responds, run_case also requires its echoed traceparent
#            to match the response header.
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
	: >"${body_file}"
	if ! response=$(curl -sS -D - -o "${body_file}" "$@" "${BASE_URL}/"); then
		response=""
	fi
	local body
	body=$(<"${body_file}")

	local status
	status=$(awk 'NR==1 {print $2}' <<<"${response}")
	local traceparent
	traceparent=$(awk 'BEGIN{IGNORECASE=1} /^traceparent:/ {print $2}' <<<"${response}" | tr -d '\r')
	local response_trace_id
	response_trace_id="${traceparent#00-}"
	response_trace_id="${response_trace_id%%-*}"
	local body_trace_id
	body_trace_id=$(jq -r '.trace_id // ""' "${body_file}" 2>/dev/null || true)
	local upstream_ok
	upstream_ok=$(jq -r 'if has("upstream_ok") then .upstream_ok else "" end' "${body_file}" 2>/dev/null || true)
	local upstream_traceparent
	upstream_traceparent=$(jq -r '.upstream_saw.traceparent // ""' "${body_file}" 2>/dev/null || true)

	echo "   status:      ${status:-<missing>}"
	echo "   traceparent: ${traceparent:-<missing>}"
	echo "   body_trace:  ${body_trace_id:-<missing>}"
	echo "   upstream_ok: ${upstream_ok:-<missing>}"
	echo "   upstream_tp: ${upstream_traceparent:-<missing>}"
	echo "   body:        ${body:-<missing>}"

	# The predicate references response fields that are in scope here.
	if ! eval "${predicate}"; then
		echo "   ✗ fail"
		fail=$((fail + 1))
		return
	fi

	if [[ "${body_trace_id}" != "${response_trace_id}" ]]; then
		echo "   ✗ body trace_id mismatch"
		fail=$((fail + 1))
		return
	fi

	if [[ "${upstream_ok}" != "true" ]]; then
		echo "   ✗ upstream unavailable"
		fail=$((fail + 1))
		return
	fi

	if [[ "${upstream_traceparent}" != "${traceparent}" ]]; then
		echo "   ✗ upstream traceparent mismatch"
		fail=$((fail + 1))
		return
	fi

	echo "   ✓ pass"
	pass=$((pass + 1))
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
