#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";
import { errorMessage, redactSecrets } from "./types.js";
import { runDoctor, formatDoctorText } from "./doctor.js";
import { resolveCorePath } from "./core.js";

export async function main(): Promise<void> {
  const isDoctor = process.argv[2] === "doctor";
  if (isDoctor) {
    const isJson = process.argv.includes("--json");
    const fetchJson = async (url: string, timeoutMs: number) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(id);
      }
    };

    const deps = {
      fetchJson,
      nodeVersion: process.version,
      resolveCore: () => resolveCorePath(process.env),
      exists: existsSync
    };

    const result = await runDoctor(process.env, deps);

    if (isJson) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(formatDoctorText(result) + "\n");
    }

    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

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
    const secrets = [
      process.env.BINANCE_API_KEY,
      process.env.BINANCE_API_SECRET,
      process.env.BRAVE_API_KEY,
      process.env.TAVILY_API_KEY,
      process.env.FIRECRAWL_API_KEY,
    ].filter((value): value is string => Boolean(value));
    process.stderr.write(`${redactSecrets(errorMessage(err), secrets)}\n`);
    process.exitCode = 1;
  });
}
