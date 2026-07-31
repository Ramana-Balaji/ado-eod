import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const serverCmd = { command: "node", args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "serve"] };

interface Ide {
  name: string;
  detect: () => boolean;
  wire: () => string; // returns human-readable result
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeJsonMerged(path: string, mutate: (doc: any) => void): void {
  const doc = readJson(path);
  mutate(doc);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

/** Accepts "contoso", "https://dev.azure.com/contoso/My%20Project/...", or "contoso.visualstudio.com". */
export function parseAdoInput(input: string): { org?: string; project?: string } {
  const s = input.trim().replace(/^https?:\/\//, "");
  let m = s.match(/^dev\.azure\.com\/([^/\s]+)(?:\/([^/\s?#]+))?/i);
  if (m) return { org: m[1], project: m[2] ? decodeURIComponent(m[2]).replace(/\+/g, " ") : undefined };
  m = s.match(/^([^./\s]+)\.visualstudio\.com(?:\/([^/\s?#]+))?/i);
  if (m) return { org: m[1], project: m[2] ? decodeURIComponent(m[2]).replace(/\+/g, " ") : undefined };
  if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(s)) return { org: s };
  return {};
}

const IDES: Ide[] = [
  {
    name: "Claude Code",
    detect: () => existsSync(join(HOME, ".claude")),
    wire: () => {
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
  },
  {
    name: "Codex",
    detect: () => existsSync(join(HOME, ".codex")),
    wire: () => {
      // TOML — append a section if absent; never rewrite the user's file
      const path = join(HOME, ".codex", "config.toml");
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (/^\[mcp_servers\.ado-eod\]/m.test(current)) return "already present in config.toml";
      const block = `\n[mcp_servers.ado-eod]\ncommand = "${serverCmd.command}"\nargs = [${serverCmd.args.map((a) => `"${a}"`).join(", ")}]\n`;
      writeFileSync(path, current + block);
      return "appended to ~/.codex/config.toml";
    },
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
  },
];

export async function setup(argv: string[] = []): Promise<void> {
  console.log("ado-eod setup\n");

  // --org <name> --project <name> → machine-local rules file.
  // No flags? Ask. People paste URLs, not org slugs — accept either.
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  let org = flag("org");
  let project = flag("project");
  const userRulesPath = join(HOME, ".ado-eod", "rules.yaml");

  if (!org && !existsSync(userRulesPath) && process.stdin.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log("  Where do your tickets live? Open Azure DevOps in your browser and");
    console.log("  copy the address — it looks like: https://dev.azure.com/contoso/Contoso%20Web\n");
    const answer = (await rl.question("  Paste that address (or just your organization name): ")).trim();
    ({ org, project } = parseAdoInput(answer));
    if (org && !project) {
      project = (await rl.question(`  Project name inside "${org}" (Enter to skip): `)).trim() || undefined;
    }
    rl.close();
  } else if (org) {
    // --org may also be a pasted URL
    const parsed = parseAdoInput(org);
    org = parsed.org;
    project = project ?? parsed.project;
  }

  if (org) {
    const lines = [`# ado-eod machine-local rules`, `ado:`, `  org: ${org}`];
    if (project) lines.push(`  project: ${project}`);
    mkdirSync(dirname(userRulesPath), { recursive: true });
    writeFileSync(userRulesPath, lines.join("\n") + "\n");
    console.log(`  ✓ Saved org "${org}"${project ? ` / project "${project}"` : ""} to ${userRulesPath}`);
  } else if (!existsSync(userRulesPath)) {
    console.log("  ! No Azure DevOps organization configured yet.");
    console.log("    Your org is the first name in your Azure DevOps address: dev.azure.com/<org>");
    console.log('    Re-run:  npx ado-eod setup --org contoso --project "Contoso Web"\n');
  }

  const found: string[] = [];
  for (const ide of IDES) {
    if (!ide.detect()) continue;
    try {
      const result = ide.wire();
      found.push(ide.name);
      console.log(`  ✓ ${ide.name} — ${result}`);
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
      const me = await new AdoClient(rules).whoAmI();
      console.log(`  ✓ Signed in as ${me.displayName} <${me.email}>`);
    } catch (e: any) {
      console.log(`  ✗ Sign-in failed: ${e.message?.slice(0, 200)}`);
      console.log("  Fix: run `az login` if you have Azure CLI, or set ADO_EOD_PAT to a personal access token.");
    }
  }

  console.log(`\nDone. Restart ${found.join(" / ")} and try: "update my ticket for today"`);
}
