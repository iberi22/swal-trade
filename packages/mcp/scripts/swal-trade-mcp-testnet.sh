#!/usr/bin/env bash
set -euo pipefail

# swal-trade-mcp-testnet.sh
# Testnet-only wrapper for swal-trade MCP server in Claude Code.
# Reads credentials strictly from ~/.config/swal-trade/testnet.env.

# Hard safety: refuse mainnet network immediately
if [[ "${SWAL_MCP_NETWORK:-}" == "mainnet" ]]; then
  echo "Refused: SWAL_MCP_NETWORK is set to mainnet. This wrapper is strictly for testnet." >&2
  exit 1
fi

ENV_FILE="${HOME}/.config/swal-trade/testnet.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE: file not found. Create it with BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET." >&2
  exit 1
fi

API_KEY=""
API_SECRET=""

while IFS='=' read -r key val || [[ -n "$key" ]]; do
  # Trim leading and trailing whitespace
  key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  # Skip comments and empty lines
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  # Trim quotes from value if present
  val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  val="${val#\"}"
  val="${val%\"}"
  val="${val#\'}"
  val="${val%\'}"
  if [[ "$key" == "BINANCE_TESTNET_API_KEY" ]]; then
    API_KEY="$val"
  elif [[ "$key" == "BINANCE_TESTNET_API_SECRET" ]]; then
    API_SECRET="$val"
  fi
done < "$ENV_FILE"

if [[ -z "$API_KEY" || -z "$API_SECRET" ]]; then
  echo "missing $ENV_FILE: BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET are required." >&2
  exit 1
fi

# Unset mainnet confirmation
unset SWAL_MCP_MAINNET_CONFIRM || true

# Export credentials under names expected by server (never echo them)
export BINANCE_API_KEY="$API_KEY"
export BINANCE_API_SECRET="$API_SECRET"

# Enforce testnet trading flags
export SWAL_MCP_TRADING="enabled"
export SWAL_MCP_NETWORK="testnet"

# Conservative risk limits
export SWAL_MAX_NOTIONAL_USD="${SWAL_MAX_NOTIONAL_USD:-25}"
export SWAL_MAX_LEVERAGE="${SWAL_MAX_LEVERAGE:-2}"
export SWAL_DAILY_LOSS_USD="${SWAL_DAILY_LOSS_USD:-10}"
export SWAL_MCP_SYMBOLS="${SWAL_MCP_SYMBOLS:-BTCUSDT}"
export SWAL_MCP_JOURNAL="${SWAL_MCP_JOURNAL:-$HOME/.swal-trade/testnet-journal.jsonl}"

# Resolve dist/index.js relative to this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_ENTRY="$PKG_ROOT/dist/index.js"

if [[ ! -f "$SERVER_ENTRY" ]]; then
  echo "Error: $SERVER_ENTRY not found. Run 'npm run build' in $PKG_ROOT first." >&2
  exit 1
fi

exec node "$SERVER_ENTRY"
