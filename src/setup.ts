import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

/**
 * Absolute path to a node binary, never the bare name.
 * GUI-launched IDEs (Cursor, Claude Desktop) do NOT inherit the shell PATH, so a
 * bare "npx" is ENOENT under nvm/fnm/volta — the server silently never starts and the
 * assistant falls back to the az CLI. process.execPath is the node running setup.
 */
function nodeBin(name: "node" | "npx"): string {
  if (name === "node") return process.execPath;
  const dir = dirname(process.execPath);
  for (const candidate of [join(dir, "npx"), join(dir, "npx.cmd")]) {
    if (existsSync(candidate)) return candidate;
  }
  return "npx"; // last resort — PATH lookup
}

// Where the IDEs will launch the server from. Mutable: setup upgrades an npx-cache
// launch to a self-managed install when it can, because the shared npx cache never
// refreshes itself — the single biggest source of "the fix didn't reach me".
let serverCmd = /[\\/]_npx[\\/]/.test(cliPath)
  ? { command: nodeBin("npx"), args: ["-y", "github:Ramana-Balaji/ado-eod", "serve"] }
  : { command: nodeBin("node"), args: [cliPath, "serve"] };

interface Ide {
  name: string;
  detect: () => boolean;
  /** Human-readable result, or null when the IDE already has it and must be left alone. */
  wire: () => string | null;
  /** Install the workflow skill for this IDE. Returns a result note, or null when unsupported. */
  installSkill?: (skillText: string) => string | null;
}

const skillSource = join(dirname(dirname(fileURLToPath(new URL(import.meta.url)))), "..", "skills", "ado-eod", "SKILL.md");

/** Copy SKILL.md into a skills dir (Claude Code / Cursor / Codex all use the same layout). */
function dropSkill(dir: string, skillText: string): string {
  const dest = join(dir, "ado-eod", "SKILL.md");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, skillText);
  return `skill installed at ${dest.replace(HOME, "~")}`;
}

export const AG_MARKERS = ["<!-- ado-eod:start -->", "<!-- ado-eod:end -->"] as const;

/** Replace-or-append a marker-guarded block — re-runs must never duplicate it. */
export function upsertMarkerBlock(existing: string, block: string): string {
  const [start, end] = AG_MARKERS;
  const guarded = `${start}\n${block}\n${end}`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (re.test(existing)) return existing.replace(re, guarded);
  return existing ? `${existing.trimEnd()}\n\n${guarded}\n` : `${guarded}\n`;
}

function writeJsonMerged(path: string, mutate: (doc: any) => void): void {
  let doc: any = {};
  if (existsSync(path)) {
    // a corrupt config (e.g. ~/.claude.json holds OAuth + trust state) must fail loudly,
    // not be silently replaced with just our server entry
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`${path} exists but is not valid JSON — fix or remove it first`);
    }
  }
  mutate(doc);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

/**
 * Pull org/project/work-item-id out of a pasted ADO link.
 * This is how a new user configures the tool — the link they already have carries
 * everything, so setup never has to ask.
 */
export function parseWorkItemUrl(input: string): { org?: string; project?: string; id?: number } {
  const { org, project } = parseAdoInput(input);
  const m = input.match(/_workitems\/edit\/(\d+)/i) ?? input.match(/\/_workitems\/(\d+)/i);
  const id = m ? Number(m[1]) : undefined;
  // ".../_workitems/edit/123" — "_workitems" is a route segment, never the project
  return { org, project: project && /^_/.test(project) ? undefined : project, id };
}

/** Accepts "contoso", "https://dev.azure.com/contoso/My%20Project/...", or "contoso.visualstudio.com". */
export function parseAdoInput(input: string): { org?: string; project?: string } {
  const decode = (p: string) => {
    // "100%_done" in a pasted project name must not throw URIError out of the tool call
    try {
      return decodeURIComponent(p).replace(/\+/g, " ");
    } catch {
      return p.replace(/\+/g, " ");
    }
  };
  const s = input.trim().replace(/^https?:\/\//i, "");
  let m = s.match(/^dev\.azure\.com\/([^/\s]+)(?:\/([^/\s?#]+))?/i);
  if (m) return { org: m[1], project: m[2] ? decode(m[2]) : undefined };
  // legacy URLs may carry /DefaultCollection/ before the project — it is not the project
  m = s.match(/^([^./\s]+)\.visualstudio\.com(?:\/DefaultCollection)?(?:\/([^/\s?#]+))?/i);
  if (m) return { org: m[1], project: m[2] ? decode(m[2]) : undefined };
  if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(s)) return { org: s };
  return {};
}

/**
 * True when `claude plugin install ado-eod@…` already provided the server + skill.
 * Setup must then leave Claude Code alone — wiring it again registers the server twice.
 */
export function hasAdoEodPlugin(installedPluginsJson: string): boolean {
  try {
    const plugins = JSON.parse(installedPluginsJson)?.plugins;
    return Object.keys(plugins ?? {}).some((k) => k.split("@")[0] === "ado-eod");
  } catch {
    return false;
  }
}

const IDES: Ide[] = [
  {
    name: "Claude Code",
    detect: () => existsSync(join(HOME, ".claude")),
    wire: () => {
      const registry = join(HOME, ".claude", "plugins", "installed_plugins.json");
      if (existsSync(registry) && hasAdoEodPlugin(readFileSync(registry, "utf8"))) return null;
      try {
        execFileSync("claude", ["mcp", "add", "--scope", "user", "ado-eod", "--", serverCmd.command, ...serverCmd.args], { stdio: "pipe" });
        return "registered via `claude mcp add`";
      } catch {
        // fall back to writing ~/.claude.json directly
        writeJsonMerged(join(HOME, ".claude.json"), (doc) => {
          doc.mcpServers ??= {};
          doc.mcpServers["ado-eod"] = serverCmd;
        });
        return "written to ~/.claude.json";
      }
    },
    installSkill: (s) =>
      dropSkill(join(HOME, ".claude", "skills"), s) +
      "\n      (tip: Claude Code can instead install this as a plugin — see the README)",
  },
  {
    name: "Codex",
    detect: () => existsSync(join(HOME, ".codex")),
    wire: () => {
      // TOML — append a section if absent; never rewrite the user's file
      const path = join(HOME, ".codex", "config.toml");
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (/^\[mcp_servers\.ado-eod\]/m.test(current)) return "already present in config.toml";
      // TOML basic strings treat \ as escape — an unescaped Windows path corrupts the whole file
      const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      const block = `\n[mcp_servers.ado-eod]\ncommand = ${q(serverCmd.command)}\nargs = [${serverCmd.args.map(q).join(", ")}]\n`;
      writeFileSync(path, current + block);
      return "appended to ~/.codex/config.toml";
    },
    installSkill: (s) => dropSkill(join(HOME, ".codex", "skills"), s),
  },
  {
    name: "Cursor",
    detect: () => existsSync(join(HOME, ".cursor")),
    wire: () => {
      writeJsonMerged(join(HOME, ".cursor", "mcp.json"), (doc) => {
        doc.mcpServers ??= {};
        doc.mcpServers["ado-eod"] = serverCmd;
      });
      return "written to ~/.cursor/mcp.json";
    },
    installSkill: (s) => dropSkill(join(HOME, ".cursor", "skills"), s),
  },
  {
    name: "Antigravity",
    detect: () => existsSync(join(HOME, ".gemini", "antigravity")) || existsSync(join(HOME, ".antigravity")),
    wire: () => {
      writeJsonMerged(join(HOME, ".gemini", "antigravity", "mcp_config.json"), (doc) => {
        doc.mcpServers ??= {};
        doc.mcpServers["ado-eod"] = serverCmd;
      });
      return "written to ~/.gemini/antigravity/mcp_config.json";
    },
    installSkill: (s) => {
      // no skills dir — the instruction file is global_rules.md; marker-guarded so
      // re-runs replace our block instead of stacking duplicates
      const path = join(HOME, ".codeium", "memories", "global_rules.md");
      const body = s.replace(/^---[\s\S]*?---\n/, ""); // frontmatter is skills-format-specific
      mkdirSync(dirname(path), { recursive: true });
      const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
      writeFileSync(path, upsertMarkerBlock(existing, body));
      return `rules block written to ${path.replace(HOME, "~")}`;
    },
  },
];

export async function setup(argv: string[] = []): Promise<void> {
  console.log("ado-eod setup\n");

  // Prefer a copy we own over the npx cache: it can be updated in place later and
  // never gets evicted underneath the IDE.
  if (serverCmd.command.includes("npx") && !argv.includes("--no-managed-install")) {
    const { installLatest, managedCli, APP_DIR } = await import("./update.js");
    process.stdout.write("  Installing ado-eod (first run builds from source, ~1-2 min)… ");
    const r = await installLatest();
    if (r.ok) {
      serverCmd = { command: nodeBin("node"), args: [managedCli(), "serve"] };
      console.log(`done\n  ✓ Installed to ${APP_DIR.replace(HOME, "~")} — updates apply here, no npx cache involved`);
    } else {
      console.log("could not install a managed copy; falling back to npx");
    }
  }

  // Org/project are NOT asked here — the first ticket link the user pastes in chat
  // carries both, and eod_configure saves them. Flags stay for scripted installs.
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  let org = flag("org");
  let project = flag("project");
  const userRulesPath = join(HOME, ".ado-eod", "rules.yaml");

  if (org) {
    const parsed = parseAdoInput(org); // --org may also be a pasted URL
    org = parsed.org;
    project = project ?? parsed.project;
  }

  if (org) {
    const { writeUserRules } = await import("./rules.js");
    writeUserRules(org, project);
    console.log(`  ✓ Saved org "${org}"${project ? ` / project "${project}"` : ""} to ${userRulesPath}`);
  }

  const skillText = existsSync(skillSource) ? readFileSync(skillSource, "utf8") : null;
  const found: string[] = [];
  for (const ide of IDES) {
    if (!ide.detect()) continue;
    try {
      const result = ide.wire();
      found.push(ide.name);
      if (result === null) {
        // plugin install already ships server + skill — touching either would duplicate it
        console.log(`  ✓ ${ide.name} — plugin already installed; left as-is`);
        continue;
      }
      console.log(`  ✓ ${ide.name} — ${result}`);
      if (skillText && ide.installSkill) {
        const note = ide.installSkill(skillText);
        if (note) console.log(`    ↳ ${note}`);
      }
    } catch (e: any) {
      console.log(`  ✗ ${ide.name} — ${e.message}. Fix: check the file is valid JSON/TOML, then re-run \`npx ado-eod setup\`.`);
    }
  }
  if (!found.length) {
    console.log("  No supported IDE found (Claude Code, Codex, Cursor, Antigravity).");
    console.log("  Install one, then re-run: npx ado-eod setup");
    return;
  }

  // sign in now, while the person is at the keyboard — first token also warms the cache
  const { loadRules } = await import("./rules.js");
  const { rules } = loadRules();
  if (rules.ado.org) {
    console.log("\nSigning in to Azure DevOps (a browser window may open once)…");
    try {
      const { AdoClient } = await import("./ado.js");
      // never hang the terminal — an unanswered browser prompt otherwise waits forever
      const me = await Promise.race([
        new AdoClient(rules).whoAmI(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out after 120s")), 120_000).unref()),
      ]);
      console.log(`  ✓ Signed in as ${me.displayName} <${me.email}>`);
    } catch (e: any) {
      console.log(`  ✗ Sign-in incomplete: ${e.message?.slice(0, 200)}`);
      console.log("  You can finish later — the first tool call will prompt again.");
      console.log("  Alternatives: `az login` if you have Azure CLI, or set ADO_EOD_PAT to a personal access token.");
    }
  }

  console.log(`\nUpdates: checked automatically; a new release installs in the background and applies on the next restart.`);
  console.log(`\nDone. Restart ${found.join(" / ")}, then paste any ticket link in chat:`);
  console.log("  \"update https://dev.azure.com/<org>/<project>/_workitems/edit/12345 with today's work\"");
  console.log("  (the link tells it your org and project — nothing else to configure)");
}
