#!/usr/bin/env bash
# CI local: equivalente reducido de .github/workflows/ci.yml.
# Uso: scripts/ci-local.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail=0
step() { echo; echo "==> $*"; }

step "Tests del Worker"
node --test workers/public-site/test/ || fail=1

step "Sintaxis"
node --check workers/public-site/src/worker.js || fail=1
node --check workers/public-site/static/app.js || fail=1
bash -n scripts/publish-public-snapshot.sh || fail=1

step "gitleaks"
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --no-git -s . --redact || fail=1
  if [ -d .git ]; then gitleaks detect -s . --redact || fail=1; fi
elif command -v nix >/dev/null 2>&1; then
  nix run nixpkgs#gitleaks -- detect --no-git -s . --redact || fail=1
  if [ -d .git ]; then nix run nixpkgs#gitleaks -- detect -s . --redact || fail=1; fi
else
  echo "gitleaks no está instalado: se omite (el CI remoto sí lo ejecuta)"
fi

echo
if [ "$fail" -eq 0 ]; then echo "CI local: OK"; else echo "CI local: FALLÓ"; fi
exit "$fail"
