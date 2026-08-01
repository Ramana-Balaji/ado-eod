import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdoInput, upsertMarkerBlock, AG_MARKERS, hasAdoEodPlugin } from "../src/setup.js";

test("upsertMarkerBlock appends once, then replaces — never duplicates on re-run", () => {
  const v1 = upsertMarkerBlock("# my own rules\n", "ado-eod skill v1");
  assert.equal(v1.includes("ado-eod skill v1"), true);
  assert.equal(v1.startsWith("# my own rules"), true); // user content preserved
  const v2 = upsertMarkerBlock(v1, "ado-eod skill v2");
  assert.equal(v2.includes("ado-eod skill v2"), true);
  assert.equal(v2.includes("ado-eod skill v1"), false); // replaced, not stacked
  assert.equal(v2.split(AG_MARKERS[0]).length, 2); // exactly one start marker
  // empty file case
  assert.equal(upsertMarkerBlock("", "x").trim().startsWith(AG_MARKERS[0]), true);
});

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

test("hasAdoEodPlugin: setup skips Claude Code wiring when the plugin owns it", () => {
  // real installed_plugins.json shape — keys are "<plugin>@<marketplace>"
  const withPlugin = JSON.stringify({
    version: 2,
    plugins: {
      "code-review@claude-plugins-official": [{ scope: "user" }],
      "ado-eod@ado-eod": [{ scope: "user", version: "0.2.0" }],
    },
  });
  assert.equal(hasAdoEodPlugin(withPlugin), true);
  // a different marketplace still counts — same server, same duplicate risk
  assert.equal(hasAdoEodPlugin(JSON.stringify({ plugins: { "ado-eod@my-fork": [{}] } })), true);
  // not installed → setup must wire it
  assert.equal(hasAdoEodPlugin(JSON.stringify({ version: 2, plugins: { "ponytail@ponytail": [{}] } })), false);
  // a name that merely starts with "ado-eod" is a different plugin
  assert.equal(hasAdoEodPlugin(JSON.stringify({ plugins: { "ado-eod-extras@x": [{}] } })), false);
  // unreadable / empty registry → wire it rather than silently skipping setup
  assert.equal(hasAdoEodPlugin("not json"), false);
  assert.equal(hasAdoEodPlugin("{}"), false);
});
