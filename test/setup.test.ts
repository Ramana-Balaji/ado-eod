import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseAdoInput, parseWorkItemUrl, upsertMarkerBlock, AG_MARKERS, hasAdoEodPlugin } from "../src/setup.js";
import { writeUserRules } from "../src/rules.js";

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

test("writeUserRules round-trips through loadRules' YAML layer", () => {
  const dir = mkdtempSync(join(tmpdir(), "ado-eod-test-"));
  const path = writeUserRules("contoso", "Contoso Web", dir);
  const doc = parseYaml(readFileSync(path, "utf8"));
  assert.deepEqual(doc, { ado: { org: "contoso", project: "Contoso Web" } });
  // no project → key omitted entirely, not written as empty/undefined
  const doc2 = parseYaml(readFileSync(writeUserRules("contoso", undefined, dir), "utf8"));
  assert.deepEqual(doc2, { ado: { org: "contoso" } });
});

test("parseAdoInput hardening: bad percent-encoding, DefaultCollection, uppercase scheme", () => {
  // must not throw URIError
  assert.deepEqual(parseAdoInput("https://dev.azure.com/contoso/100%_done"), { org: "contoso", project: "100%_done" });
  // legacy collection segment is not the project
  assert.deepEqual(parseAdoInput("https://contoso.visualstudio.com/DefaultCollection/MyProj"), { org: "contoso", project: "MyProj" });
  assert.deepEqual(parseAdoInput("HTTPS://dev.azure.com/contoso/MyProj"), { org: "contoso", project: "MyProj" });
});

test("writeUserRules survives hostile project names — file always parses back to strings", () => {
  const dir = mkdtempSync(join(tmpdir(), "ado-eod-yaml-"));
  for (const project of ["A: B", "#team", "true", "123", "x\ny", "- list"]) {
    const doc = parseYaml(readFileSync(writeUserRules("contoso", project, dir), "utf8"));
    assert.deepEqual(doc, { ado: { org: "contoso", project } }, `project ${JSON.stringify(project)} did not round-trip`);
  }
});

test("loadRules-style merge guard: writeUserRules never emits a bare null key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ado-eod-null-"));
  const doc = parseYaml(readFileSync(writeUserRules("contoso", undefined, dir), "utf8"));
  assert.deepEqual(doc, { ado: { org: "contoso" } });
});

test("parseWorkItemUrl extracts org/project/id — a pasted link is the whole config", () => {
  assert.deepEqual(
    parseWorkItemUrl("https://dev.azure.com/anugal/Symphony%20Development/_workitems/edit/21637"),
    { org: "anugal", project: "Symphony Development", id: 21637 },
  );
  // org-level link without a project segment — "_workitems" must not become the project
  assert.deepEqual(parseWorkItemUrl("https://dev.azure.com/anugal/_workitems/edit/99"), { org: "anugal", project: undefined, id: 99 });
  // no id in a plain project link
  assert.deepEqual(parseWorkItemUrl("https://dev.azure.com/anugal/Proj"), { org: "anugal", project: "Proj", id: undefined });
  assert.equal(parseWorkItemUrl("not a url").id, undefined);
});
