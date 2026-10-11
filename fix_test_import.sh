#!/bin/bash
cat << 'INNER_EOF' > apps/extension/src/lib/bridge-handler.test.ts
import { describe, expect, it, vi } from 'vitest';
// Instead of importing from entrypoint (which requires wxt defineContentScript),
// we will just recreate the logic to unit test the handler logic or test it in an isolated module.
// But since we injected createBridgeMessageHandler directly into the file, we can just mock defineContentScript globally before importing.
INNER_EOF
