import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { Rules, redactPatterns, expandHome } from "./rules.js";

export type WorkType = "analysis" | "implementation" | "documentation" | "testing" | "debugging";

export interface SessionRecord {
  source: "claude-code" | "codex" | "cursor";
  sessionId: string;
  title?: string;
  cwd?: string;
  branches: string[];
  first: string; // ISO
  last: string; // ISO
  activeMinutes: number;
  precision: "fine" | "coarse";
  prompts: string[];
  tools: Record<string, number>;
  files: string[];
  ticketIds: string[];
  workType: WorkType;
}

export interface GitEvidence {
  repo: string;
  branch: string;
  commits: string[]; // subject lines for the day
  ticketIds: string[];
  hasSession: boolean; // false = git-only evidence (Antigravity / other gap)
}

export interface DayEvidence {
  date: string;
  sessions: SessionRecord[];
  git: GitEvidence[];
  redactedLineCount: number;
}

// ---------- local-day handling ----------
// Users live in local time; transcripts store UTC. "Today" is the LOCAL calendar day,
// converted to a UTC instant range. String-prefix matching on UTC dates silently loses
// evenings for anyone east of UTC (e.g. IST) — hence range checks everywhere.

export function dayRange(date: string): { startMs: number; endMs: number; utcDates: string[] } {
  const startMs = new Date(`${date}T00:00:00`).getTime(); // parsed as LOCAL midnight
  const endMs = startMs + 24 * 60 * 60 * 1000;
  const utcDates = [...new Set([new Date(startMs).toISOString().slice(0, 10), new Date(endMs - 1).toISOString().slice(0, 10)])];
  return { startMs, endMs, utcDates };
}

export function inRange(ts: string, r: { startMs: number; endMs: number }): boolean {
  const ms = Date.parse(ts);
  return !isNaN(ms) && ms >= r.startMs && ms < r.endMs;
}

/** Local YYYY-MM-DD for "today" — NOT the UTC date. */
export function localToday(): string {
  return new Date().toLocaleDateString("en-CA");
}

// ---------- prompt cleaning ----------

const NOISE_RE = /<(local-command-[a-z]*|command-message|command-name|command-args|local-command-stdout|system-reminder|timestamp)>[\s\S]*?<\/\1>/g;
const BARE_SLASH_CMD = /^\/[a-z][a-z0-9:-]*\s*$/;

export function cleanPrompt(text: string, redact: RegExp[]): { text: string | null; redacted: number } {
  let redactedCount = 0;
  const stripped = text.replace(NOISE_RE, "").trim();
  if (!stripped || BARE_SLASH_CMD.test(stripped)) return { text: null, redacted: 0 };
  const kept = stripped
    .split("\n")
    .filter((line) => {
      if (redact.some((re) => re.test(line))) {
        redactedCount++;
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
  return { text: kept || null, redacted: redactedCount };
}

// ---------- derived measures ----------

/** Active minutes: total span minus idle gaps > threshold. Timestamps need not be sorted. */
export function activeMinutes(timestamps: string[], idleGapMinutes: number): number {
  if (timestamps.length < 2) return timestamps.length ? 1 : 0;
  const ts = timestamps.map((t) => Date.parse(t)).sort((a, b) => a - b);
  const gapMs = idleGapMinutes * 60_000;
  let active = 0;
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d <= gapMs) active += d;
  }
  return Math.round(active / 60_000);
}

export function classifyWorkType(tools: Record<string, number>, files: string[]): WorkType {
  const edits = (tools["Edit"] ?? 0) + (tools["Write"] ?? 0) + (tools["NotebookEdit"] ?? 0);
  const editedFiles = files.filter(Boolean);
  const isTest = (f: string) => /(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.[jt]sx?$/.test(f) || /test_.*\.py$/.test(f);
  if (edits === 0) return "analysis";
  if (editedFiles.length > 0 && editedFiles.every((f) => f.endsWith(".md"))) return "documentation";
  if (editedFiles.some(isTest) && editedFiles.every((f) => isTest(f) || f.endsWith(".md"))) return "testing";
  return "implementation";
}

export function extractTicketIds(texts: string[], pattern: string): string[] {
  const re = new RegExp(pattern, "gi");
  const ids = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(re)) ids.add(m[1] ?? m[0]);
  }
  return [...ids];
}

/** Round hours to nearest step, cap at maxPerDay. */
export function roundAndCapHours(minutes: number, rules: Rules): number {
  const step = rules.hours.roundToHours;
  const h = Math.round(minutes / 60 / step) * step;
  return Math.min(h, rules.hours.maxPerDay);
}

// ---------- Claude Code ----------

async function scanClaudeFile(path: string, range: ReturnType<typeof dayRange>, rules: Rules, redact: RegExp[], counters: { redacted: number }): Promise<Map<string, SessionRecord>> {
  const sessions = new Map<string, SessionRecord>();
  const timestamps = new Map<string, string[]>();
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!range.utcDates.some((ud) => line.includes(ud))) {
      // custom-title records carry no timestamp; attach to any session already seen
      if (line.includes('"custom-title"')) {
        try {
          const d = JSON.parse(line);
          const s = sessions.get(d.sessionId);
          if (s) s.title = d.customTitle;
        } catch {}
      }
      continue;
    }
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ts: string = d.timestamp ?? "";
    if (!inRange(ts, range) || !d.sessionId) continue;
    let s = sessions.get(d.sessionId);
    if (!s) {
      s = {
        source: "claude-code", sessionId: d.sessionId, cwd: undefined, branches: [],
        first: ts, last: ts, activeMinutes: 0, precision: "fine",
        prompts: [], tools: {}, files: [], ticketIds: [], workType: "analysis",
      };
      sessions.set(d.sessionId, s);
      timestamps.set(d.sessionId, []);
    }
    timestamps.get(d.sessionId)!.push(ts);
    if (ts < s.first) s.first = ts;
    if (ts > s.last) s.last = ts;
    if (d.cwd) s.cwd = d.cwd;
    if (d.gitBranch && d.gitBranch !== "HEAD" && !s.branches.includes(d.gitBranch)) s.branches.push(d.gitBranch);
    const m = d.message ?? {};
    if (d.type === "user" && typeof m.content === "string") {
      const { text, redacted } = cleanPrompt(m.content, redact);
      counters.redacted += redacted;
      if (text) s.prompts.push(text.slice(0, 500));
    }
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === "tool_use") {
          s.tools[b.name] = (s.tools[b.name] ?? 0) + 1;
          const fp = b.input?.file_path;
          if (fp && !s.files.includes(fp)) s.files.push(fp);
        }
      }
    }
  }
  for (const [id, s] of sessions) {
    s.activeMinutes = activeMinutes(timestamps.get(id)!, rules.hours.idleGapMinutes);
    s.workType = classifyWorkType(s.tools, s.files);
    s.ticketIds = extractTicketIds([...s.prompts, ...s.files, ...s.branches], rules.ado.ticketIdPattern);
  }
  return sessions;
}

async function collectClaude(range: ReturnType<typeof dayRange>, rules: Rules, redact: RegExp[], counters: { redacted: number }): Promise<SessionRecord[]> {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const out: SessionRecord[] = [];
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      // cheap pre-filter: a file last written before the day started can't contain it
      try {
        if (statSync(path).mtimeMs < range.startMs) continue;
      } catch {
        continue;
      }
      const sessions = await scanClaudeFile(path, range, rules, redact, counters);
      out.push(...sessions.values());
    }
  }
  // keep chat-only sessions too when they ran on a real branch — the branch IS the ticket evidence
  return out.filter((s) => s.prompts.length > 0 || Object.keys(s.tools).length > 0 || s.branches.length > 0);
}

// ---------- Codex ----------

async function collectCodex(date: string, range: ReturnType<typeof dayRange>, rules: Rules, redact: RegExp[], counters: { redacted: number }): Promise<SessionRecord[]> {
  // session dirs are date-named; cover the local date plus the UTC dates the range touches
  const dirs = [...new Set([date, ...range.utcDates])]
    .map((ds) => {
      const [y, m, d] = ds.split("-");
      return join(homedir(), ".codex", "sessions", y, m, d);
    })
    .filter(existsSync);
  if (!dirs.length) return [];
  // thread names live in the session index
  const titles = new Map<string, string>();
  const idxPath = join(homedir(), ".codex", "session_index.jsonl");
  if (existsSync(idxPath)) {
    for (const line of (await readFile(idxPath, "utf8")).split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e.id) titles.set(e.id, e.thread_name);
      } catch {}
    }
  }
  const out: SessionRecord[] = [];
  for (const { dir, f } of dirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => ({ dir, f })))) {
    const timestamps: string[] = [];
    const s: SessionRecord = {
      source: "codex", sessionId: basename(f, ".jsonl"), cwd: undefined, branches: [],
      first: "", last: "", activeMinutes: 0, precision: "fine",
      prompts: [], tools: {}, files: [], ticketIds: [], workType: "analysis",
    };
    const rl = createInterface({ input: createReadStream(join(dir, f)), crlfDelay: Infinity });
    for await (const line of rl) {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.timestamp && inRange(e.timestamp, range)) timestamps.push(e.timestamp);
      if (e.type === "session_meta") {
        s.cwd = e.payload?.cwd;
        const id = e.payload?.id;
        if (id) {
          s.sessionId = id;
          s.title = titles.get(id);
        }
      }
      // user messages appear as response_item payloads with role user
      const p = e.payload;
      if (e.type === "response_item" && p?.role === "user") {
        const texts = Array.isArray(p.content) ? p.content.map((c: any) => c?.text ?? "").join("\n") : String(p.content ?? "");
        const { text, redacted } = cleanPrompt(texts, redact);
        counters.redacted += redacted;
        if (text) s.prompts.push(text.slice(0, 500));
      }
      if (e.type === "response_item" && p?.type === "function_call" && p?.name) {
        s.tools[p.name] = (s.tools[p.name] ?? 0) + 1;
      }
    }
    if (!timestamps.length) continue;
    timestamps.sort();
    s.first = timestamps[0];
    s.last = timestamps[timestamps.length - 1];
    s.activeMinutes = activeMinutes(timestamps, rules.hours.idleGapMinutes);
    s.workType = classifyWorkType(s.tools, s.files);
    s.ticketIds = extractTicketIds([...s.prompts, s.cwd ?? ""], rules.ado.ticketIdPattern);
    out.push(s);
  }
  return out;
}

// ---------- Cursor ----------

const CURSOR_TS_RE = /<timestamp>([^<]+)<\/timestamp>/;

async function collectCursor(range: ReturnType<typeof dayRange>, rules: Rules, redact: RegExp[], counters: { redacted: number }): Promise<SessionRecord[]> {
  const root = join(homedir(), ".cursor", "projects");
  if (!existsSync(root)) return [];
  const out: SessionRecord[] = [];
  for (const proj of readdirSync(root)) {
    const tdir = join(root, proj, "agent-transcripts");
    if (!existsSync(tdir)) continue;
    for (const sub of readdirSync(tdir)) {
      const dir = join(tdir, sub);
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const path = join(dir, f);
        try {
          if (statSync(path).mtimeMs < range.startMs) continue;
        } catch {
          continue;
        }
        const s = await scanCursorFile(path, proj, range, rules, redact, counters);
        if (s) out.push(s);
      }
    }
  }
  return out;
}

async function scanCursorFile(path: string, projSlug: string, range: ReturnType<typeof dayRange>, rules: Rules, redact: RegExp[], counters: { redacted: number }): Promise<SessionRecord | null> {
  let matchesDate = false;
  const prompts: string[] = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.role !== "user") continue;
    const texts = (e.message?.content ?? [])
      .map((c: any) => c?.text ?? "")
      .join("\n");
    const tsMatch = texts.match(CURSOR_TS_RE);
    if (tsMatch) {
      const parsed = new Date(tsMatch[1]); // Cursor's tag is local time — parses to the right instant
      if (!isNaN(+parsed) && parsed.getTime() >= range.startMs && parsed.getTime() < range.endMs) matchesDate = true;
    }
    const { text, redacted } = cleanPrompt(texts.replace(CURSOR_TS_RE, ""), redact);
    counters.redacted += redacted;
    if (text) prompts.push(text.slice(0, 500));
  }
  if (!matchesDate || prompts.length === 0) return null;
  const s: SessionRecord = {
    source: "cursor", sessionId: basename(path, ".jsonl"),
    // the slug is a lossy path encoding and platform-specific — keep it as a label, not a path
    cwd: undefined, title: projSlug,
    branches: [], first: new Date(range.startMs).toISOString(), last: new Date(range.startMs).toISOString(),
    activeMinutes: 0, precision: "coarse",
    prompts, tools: {}, files: [], ticketIds: [], workType: "implementation",
  };
  s.ticketIds = extractTicketIds(prompts, rules.ado.ticketIdPattern);
  return s;
}

// ---------- git ----------

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export function collectGit(date: string, rules: Rules, sessionCwds: string[], redact: RegExp[] = []): GitEvidence[] {
  const repos = new Set<string>();
  for (const root of rules.repoRoots.map(expandHome)) {
    if (!existsSync(root)) continue;
    // repos at depth 1 and 2 under each root — covers workspace/repo layouts
    for (const a of safeDirs(root)) {
      if (existsSync(join(root, a, ".git"))) repos.add(join(root, a));
      else for (const b of safeDirs(join(root, a))) {
        if (existsSync(join(root, a, b, ".git"))) repos.add(join(root, a, b));
      }
    }
  }
  const out: GitEvidence[] = [];
  const email = git(process.cwd(), ["config", "--global", "user.email"]) || undefined;
  for (const repo of repos) {
    const since = `${date}T00:00:00`;
    const until = `${date}T23:59:59`;
    const logArgs = ["log", `--since=${since}`, `--until=${until}`, "--pretty=%s"];
    if (email) logArgs.push(`--author=${email}`);
    // commit subjects are mined text, same as prompts — redact before they can reach a comment
    const commits = git(repo, logArgs).split("\n").filter(Boolean).filter((c) => !redact.some((re) => re.test(c)));
    const branch = git(repo, ["branch", "--show-current"]);
    if (!commits.length) continue;
    const ticketIds = extractTicketIds([...commits, branch], rules.ado.ticketIdPattern);
    const hasSession = sessionCwds.some((c) => c && (c.startsWith(repo) || repo.startsWith(c)));
    out.push({ repo, branch, commits, ticketIds, hasSession });
  }
  return out;
}

function safeDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ---------- entry ----------

export async function collectDay(date: string, rules: Rules): Promise<DayEvidence> {
  const redact = redactPatterns(rules);
  const counters = { redacted: 0 };
  const range = dayRange(date);
  const [claude, codex, cursor] = await Promise.all([
    collectClaude(range, rules, redact, counters),
    collectCodex(date, range, rules, redact, counters),
    collectCursor(range, rules, redact, counters),
  ]);
  const sessions = [...claude, ...codex, ...cursor];
  const git = collectGit(date, rules, sessions.map((s) => s.cwd ?? ""), redact);
  return { date, sessions, git, redactedLineCount: counters.redacted };
}
