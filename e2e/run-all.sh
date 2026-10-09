#!/usr/bin/env bash
# Corre el e2e completo: sitio (wrangler@4.149.0 dev --local), extensión y MCP STDIO.
# No usa claves reales. No despliega.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

if [[ ! -d node_modules/@playwright/test ]]; then
  npm install
fi

echo "== playwright chromium =="
npx playwright install chromium

if [[ -z "${E2E_PORT:-}" ]]; then
  E2E_PORT="$(node --input-type=module -e 'import net from "node:net"; const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => process.stdout.write(String(port))); });')"
fi
export E2E_PORT
echo "E2E_PORT=$E2E_PORT"

echo "== extension build =="
( cd "$ROOT/apps/extension" && npm ci && npm run build )

echo "== mcp build =="
( cd "$ROOT/packages/mcp" && npm ci && npm run build )

echo "== playwright (site + extension) =="
npx playwright test

echo "== mcp stdio =="
node mcp/stdio.test.mjs

echo "e2e: all ok"
