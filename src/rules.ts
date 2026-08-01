import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

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

/** Layered load: defaults → org file (optional) → user file. Later wins per top-level key. */
export function loadRules(): { rules: Rules; sources: Record<string, string>; configErrors: string[] } {
  const layers: Array<{ path: string; label: string }> = [
    { path: join(__dir, "..", "..", "rules.default.yaml"), label: "default" },
    { path: expandHome(process.env.ADO_EOD_ORG_RULES ?? "~/.ado-eod/org-rules.yaml"), label: "org" },
    { path: expandHome("~/.ado-eod/rules.yaml"), label: "user" },
  ];
  let merged: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  for (const { path, label } of layers) {
    if (!existsSync(path)) continue;
    const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!doc || typeof doc !== "object") continue;
    for (const [k, v] of Object.entries(doc)) {
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
  return { rules, sources, configErrors: validate(rules) };
}

/** Soft validation — the server must boot on a fresh machine and point to setup, not crash. */
function validate(r: Rules): string[] {
  const errors: string[] = [];
  if (!r.ado?.org) errors.push("ado.org is not set — run: npx ado-eod setup --org <yourorg>");
  if (!r.ado?.ticketIdPattern) errors.push("ado.ticketIdPattern is required");
  try {
    new RegExp(r.ado?.ticketIdPattern ?? "");
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
