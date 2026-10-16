#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BridgeDaemon,
  DEFAULT_BRIDGE_CONTROL_PORT,
  DEFAULT_CHART_BRIDGE_PORT,
} from "./chart-bridge.js";
import { errorMessage } from "./types.js";

export async function main(): Promise<void> {
  const wsPort = process.env.SWAL_MCP_CHART_PORT
    ? parseInt(process.env.SWAL_MCP_CHART_PORT, 10)
    : DEFAULT_CHART_BRIDGE_PORT;
  const controlPort = process.env.SWAL_BRIDGE_CONTROL_PORT
    ? parseInt(process.env.SWAL_BRIDGE_CONTROL_PORT, 10)
    : DEFAULT_BRIDGE_CONTROL_PORT;
  const tokenPath = process.env.SWAL_BRIDGE_TOKEN_PATH;

  const daemon = new BridgeDaemon({
    wsPort,
    controlPort,
    tokenPath,
  });

  try {
    await daemon.start();
    console.log(
      `swal-bridge daemon running: WS on 127.0.0.1:${daemon.wsPort}, control HTTP on 127.0.0.1:${daemon.controlPort}`
    );
    console.log(`token file: ${daemon.tokenPath}`);
  } catch (err: unknown) {
    console.error(`swal-bridge daemon failed to start: ${errorMessage(err)}`);
    process.exit(1);
  }

  const shutdown = async () => {
    console.log("swal-bridge daemon shutting down...");
    await daemon.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
