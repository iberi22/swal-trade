import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";

export async function withClient(deps, fn) {
  const server = createServer(deps);
  const client = new Client({ name: "swal-trade-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    if (typeof server.close === "function") await server.close();
  }
}

export function textOf(result) {
  assert.notEqual(result.isError, true);
  const block = result.content.find((item) => item.type === "text");
  assert.ok(block && "text" in block);
  return block.text;
}

export function errorText(result) {
  assert.equal(result.isError, true);
  const block = result.content.find((item) => item.type === "text");
  assert.ok(block && "text" in block);
  return block.text;
}

export async function callOrCatch(client, name, args) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
}

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}
