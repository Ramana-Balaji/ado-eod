import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

export interface Rules {
  version: number;
  ado: { org: string; project: string; ticketIdPattern: string };
  repoRoots: string[];
  applies: {
    projects: string[];
    workItemTypes: string[];
    onlyMyTickets: boolean;
    blockStates: string[];
  };
  comment: {
    format: "markdown" | "html";
    required: string[];
    template: string;
    signoffTemplate: string;
    /** eod_post rejects comments longer than this many lines (default 25). */
    maxLines?: number;
  };
  completion: { maxProposedState: string; requireTester: boolean };
  testScenarioField: Record<string, string>;
  /** Per-type field for acceptance criteria (e.g. Enhancement → Microsoft.VSTS.Common.AcceptanceCriteria). */
  acceptanceCriteriaField?: Record<string, string>;
  /** Identity field the sign-off tester is written to (e.g. Custom.Tester). Empty = skip. */
  testerField?: string;
  hours: { maxPerDay: number; idleGapMinutes: number; roundToHours: number };
  fields: {
    completedWork: boolean;
    remainingWork: boolean;
    state: boolean;
    longText: string[];
    /** Large-text fields written with the paired multilineFieldsFormat=Markdown op. */
    markdownFields?: string[];
  };
  redact: { extraPatterns: string[] };
  /** Self-update behaviour. auto=true installs a new release in the background at startup. */
  update?: { auto?: boolean; checkIntervalHours?: number };
}

// Hard-coded, never overridable by any rules file.
export const BASE_REDACT_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /bearer /i,
  /PRIVATE KEY/,
  /mongodb(\+srv)?:\/\//i,
  /postgres(ql)?:\/\//i,
];
const __dir = dirname(fileURLToPath(import.meta.url));

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Write the machine-local rules file (org + optional project). Shared by CLI setup and eod_configure. */
export function writeUserRules(org: string, project?: string, dir = join(homedir(), ".ado-eod")): string {
  // stringify, never concatenate — a project like "A: B" or "#team" written raw makes
  // the file unparseable (or silently null) and the server refuses to boot
  const body = stringify({ ado: { org: String(org), ...(project ? { project: String(project) } : {}) } });
  const path = join(dir, "rules.yaml");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `# ado-eod machine-local rules\n${body}`);
  return path;
}

/**
 * Which comment we posted for a ticket on a given day. Keeps re-runs idempotent
 * without printing an `eod:<date>` marker into the ticket for everyone to read.
 * Machine-local: a re-run elsewhere falls back to same-day/author detection.
 */
const postedPath = (dir = join(homedir(), ".ado-eod")) => join(dir, "posted.json");

export function rememberComment(key: string, commentId: number, dir?: string): void {
  const path = postedPath(dir);
  let doc: Record<string, number> = {};
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* first write, or corrupt — starting fresh only costs one duplicate comment */
  }
  doc[key] = commentId;
  // keep the file small: drop entries older than ~60 days by date in the key
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  for (const k of Object.keys(doc)) {
    const d = k.split("/").pop() ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) delete doc[k];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

export function recallComment(key: string, dir?: string): number | undefined {
  try {
    return JSON.parse(readFileSync(postedPath(dir), "utf8"))[key];
  } catch {
    return undefined;
  }
}

/** Layered load: defaults → org file (optional) → user file. Later wins per top-level key. */
export function loadRules(): { rules: Rules; sources: Record<string, string>; configErrors: string[] } {
  const layers: Array<{ path: string; label: string }> = [
    { path: join(__dir, "..", "..", "rules.default.yaml"), label: "default" },
    { path: expandHome(process.env.ADO_EOD_ORG_RULES ?? "~/.ado-eod/org-rules.yaml"), label: "org" },
    { path: expandHome("~/.ado-eod/rules.yaml"), label: "user" },
  ];
  let merged: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  const loadErrors: string[] = [];
  for (const { path, label } of layers) {
    if (!existsSync(path)) continue;
    let doc: Record<string, unknown>;
    try {
      doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (e: any) {
      // the server must boot and point at the broken file, not crash at import time
      loadErrors.push(`${label} rules file is invalid YAML — fix or delete it: ${path} (${e.message?.split("\n")[0]})`);
      continue;
    }
    if (!doc || typeof doc !== "object") continue;
    for (const [k, v] of Object.entries(doc)) {
      if (v == null) continue; // a bare "ado:" key must not null out the defaults
      // one-level-deep merge: a user file setting only ado.org must not wipe
      // ado.ticketIdPattern from the defaults
      const prev = merged[k];
      if (v && prev && typeof v === "object" && typeof prev === "object" && !Array.isArray(v) && !Array.isArray(prev)) {
        merged[k] = { ...prev, ...v };
      } else {
        merged[k] = v;
      }
      sources[k] = `${label} (${path})`;
    }
  }
  const rules = merged as unknown as Rules;
  return { rules, sources, configErrors: [...loadErrors, ...validate(rules)] };
}

/** Soft validation — the server must boot on a fresh machine and point to setup, not crash. */
function validate(r: Rules): string[] {
  const errors: string[] = [];
  if (!r.ado?.org)
    errors.push(
      "ado.org is not set — ask the user for their Azure DevOps address (looks like https://dev.azure.com/<org>/<project>) and call eod_configure with it; or run: npx ado-eod setup",
    );
  if (!r.ado?.ticketIdPattern) errors.push("ado.ticketIdPattern is required");
  try {
    const re = new RegExp((r.ado?.ticketIdPattern ?? "") + "|");
    // exec("") match array length = capture groups + 1 — extraction needs group 1 for the numeric id
    if ((re.exec("")?.length ?? 1) < 2)
      errors.push(`ado.ticketIdPattern needs a capture group around the numeric id, e.g. '[A-Z]{2,5}-(\\d+)': ${r.ado.ticketIdPattern}`);
  } catch {
    errors.push(`ado.ticketIdPattern is not a valid regex: ${r.ado.ticketIdPattern}`);
  }
  if (!(r.hours?.maxPerDay > 0)) errors.push("hours.maxPerDay must be > 0");
  if (!(r.hours?.idleGapMinutes > 0)) errors.push("hours.idleGapMinutes must be > 0");
  if (!Array.isArray(r.comment?.required)) errors.push("comment.required must be a list");
  for (const p of r.redact?.extraPatterns ?? []) {
    try {
      new RegExp(p);
    } catch {
      errors.push(`redact.extraPatterns contains invalid regex: ${p}`);
    }
  }
  return errors;
}

export function redactPatterns(rules: Rules): RegExp[] {
  return [
    ...BASE_REDACT_PATTERNS,
    ...(rules.redact?.extraPatterns ?? []).map((p) => new RegExp(p, "i")),
  ];
}
