#!/usr/bin/env bash
# scripts/publish-public-snapshot.sh
# Public snapshot publisher for SynapseTrader -> https://trade.swal.network/ingest

set -euo pipefail

SYNAPSE_PORT="${SYNAPSE_PORT:-19234}"
SOURCE_URL="http://127.0.0.1:${SYNAPSE_PORT}/public/v1/snapshot"
PUBLIC_INGEST_URL="${PUBLIC_INGEST_URL:-https://trade.swal.network/ingest}"

TOKEN="${PUBLIC_INGEST_TOKEN:-}"
TOKEN_FILE="${HOME}/.config/synapse/public-ingest-token"

# Resolve token from environment or file
if [ -z "$TOKEN" ]; then
  if [ -f "$TOKEN_FILE" ]; then
    PERMS=$(stat -c "%a" "$TOKEN_FILE" 2>/dev/null || stat -f "%Lp" "$TOKEN_FILE" 2>/dev/null)
    # Refuse if group or others have any permissions (read/write/exec)
    if [ -n "$PERMS" ] && [ $(( 8#$PERMS & 8#077 )) -ne 0 ]; then
      echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Insecure permissions ($PERMS) on $TOKEN_FILE; expected chmod 600" >&2
      exit 1
    fi
    TOKEN=$(head -n 1 "$TOKEN_FILE" | tr -d '\r\n')
  fi
fi

if [ -z "$TOKEN" ]; then
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: No ingest token available (set PUBLIC_INGEST_TOKEN or configure ~/.config/synapse/public-ingest-token)" >&2
  exit 1
fi

# Fetch snapshot from local engine (10 s timeout)
HTTP_RESP=$(curl -sS --max-time 10 -w "\n%{http_code}" "$SOURCE_URL" 2>/dev/null) || {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Failed to connect to $SOURCE_URL" >&2
  exit 1
}

HTTP_STATUS=$(echo "$HTTP_RESP" | tail -n 1)
BODY=$(echo "$HTTP_RESP" | sed '$d')

if [ "$HTTP_STATUS" != "200" ]; then
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Source returned HTTP $HTTP_STATUS from $SOURCE_URL" >&2
  exit 1
fi

# Validate JSON
if ! echo "$BODY" | python3 -m json.tool >/dev/null 2>&1; then
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Response from $SOURCE_URL is not valid JSON" >&2
  exit 1
fi

# POST to public ingest endpoint
POST_RESP=$(echo "$BODY" | curl -sS --max-time 10 -w "\n%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  --data-binary @- \
  "$PUBLIC_INGEST_URL" 2>/dev/null) || {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Failed to POST snapshot to $PUBLIC_INGEST_URL" >&2
  exit 1
}

POST_STATUS=$(echo "$POST_RESP" | tail -n 1)

if [ "$POST_STATUS" != "204" ] && [ "$POST_STATUS" != "200" ]; then
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Ingest endpoint returned HTTP $POST_STATUS from $PUBLIC_INGEST_URL" >&2
  exit 1
fi

BYTES=$(echo "$BODY" | wc -c | tr -d ' ')
echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] OK: Public snapshot published to $PUBLIC_INGEST_URL (${BYTES} bytes, HTTP $POST_STATUS)" >&2
exit 0
