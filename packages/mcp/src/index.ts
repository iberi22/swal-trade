#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";
import { errorMessage, redactSecrets } from "./types.js";

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
    const secrets = [process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET].filter(
      (value): value is string => Boolean(value),
    );
    process.stderr.write(`${redactSecrets(errorMessage(err), secrets)}\n`);
    process.exitCode = 1;
  });
}
