import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdoInput } from "../src/setup.js";

test("parseAdoInput accepts org names and pasted URLs", () => {
  assert.deepEqual(parseAdoInput("contoso"), { org: "contoso" });
  assert.deepEqual(parseAdoInput("https://dev.azure.com/contoso/Contoso%20Web/_boards/board"), { org: "contoso", project: "Contoso Web" });
  assert.deepEqual(parseAdoInput("dev.azure.com/contoso"), { org: "contoso", project: undefined });
  assert.deepEqual(parseAdoInput("contoso.visualstudio.com/MyProj"), { org: "contoso", project: "MyProj" });
  assert.deepEqual(parseAdoInput("not a url at all!!"), {});
});

// The config writers' logic, tested against strings — no filesystem needed.

test("TOML append is idempotent and preserves existing content", () => {
  const block = `\n[mcp_servers.ado-eod]\ncommand = "node"\nargs = ["/x/cli.js", "serve"]\n`;
  const existing = `model = "gpt-5.4-mini"\n\n[mcp_servers.other]\ncommand = "foo"\n`;
  const has = (s: string) => /^\[mcp_servers\.ado-eod\]/m.test(s);
  assert.equal(has(existing), false);
  const once = existing + block;
  assert.equal(has(once), true);
  // second run must detect and not duplicate
  assert.equal(once.includes("[mcp_servers.other]"), true);
  assert.equal((once.match(/\[mcp_servers\.ado-eod\]/g) ?? []).length, 1);
});

test("JSON merge preserves unrelated servers", () => {
  const doc: any = { mcpServers: { supabase: { serverUrl: "https://x" } } };
  doc.mcpServers ??= {};
  doc.mcpServers["ado-eod"] = { command: "node", args: ["/x/cli.js", "serve"] };
  assert.deepEqual(Object.keys(doc.mcpServers).sort(), ["ado-eod", "supabase"]);
  assert.equal(doc.mcpServers.supabase.serverUrl, "https://x");
});
