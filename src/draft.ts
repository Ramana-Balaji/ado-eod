import { AdoClient, WorkItem } from "./ado.js";
import { Rules } from "./rules.js";
import { DayEvidence, SessionRecord, roundAndCapHours, pathsOverlap } from "./worklog.js";

export interface TicketDraft {
  ticketId: number;
  /** System.Rev at draft time — eod_post requires it for its concurrent-edit guard. */
  rev?: number;
  /** The ticket's own project — people work across several, so post uses this, not a global default. */
  project?: string;
  /** The day this draft covers — eod_post needs it for same-day idempotency. */
  date?: string;
  title?: string;
  workItemType?: string;
  error?: string; // populated when the ticket can't be drafted (rules, not found…)
  sessions: string[]; // session ids feeding this draft
  hours: number;
  hoursNote?: string;
  currentCompleted?: number;
  currentRemaining?: number;
  newCompleted?: number;
  newRemaining?: number;
  percentBefore?: number | null;
  percentAfter?: number | null;
  currentState?: string;
  proposedState?: string | null;
  allowedStates?: string[];
  commentMarkdown: string;
  missingSections: string[]; // sections nothing can fill (e.g. tester on completion) → ask user
  autoFilled: string[]; // sections generated from evidence — show them; the user edits if needed
  fieldAppends: Array<{ field: string; markdown: string }>;
  setFields?: Record<string, any>; // direct sets, e.g. the tester identity field
  signoff?: { tester: string; resolved: boolean; displayName?: string; identityId?: string };
  existingEodComment?: { id: number; date: string }; // idempotency marker found
}

export interface DraftInput {
  evidence: DayEvidence;
  notes?: string; // live-conversation context from the assistant
  tickets?: number[]; // explicit ticket ids from the user's message
  completion?: { ticketId: number; tester?: string }; // user says work is complete
  testScenarios?: string[]; // routed to the org's test-scenario FIELD, never the comment
  knownCommentIds?: Record<number, number>; // ticketId → comment id we posted today
  authorDisplayName?: string; // for recognising our own same-day comment
  dayStartMs?: number;
  dayEndMs?: number;
}

export function bulletList(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

/**
 * Comment bodies are bullets, never paragraphs. Accepts what the assistant sends
 * (prose, newline list, already-bulleted) and always returns bullet lines.
 */
export function toBullets(text: string): string {
  const raw = text.trim();
  if (!raw) return "";
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  // already a list? just normalise the marker character
  if (lines.length > 1 && lines.every((l) => /^([-*•]|\d+[.)])\s+/.test(l)))
    return lines.map((l) => `- ${l.replace(/^([-*•]|\d+[.)])\s+/, "")}`).join("\n");
  const items = lines.flatMap((line) =>
    /^([-*•]|\d+[.)])\s+/.test(line)
      ? [line.replace(/^([-*•]|\d+[.)])\s+/, "")]
      // split prose into sentences — ". " outside of abbreviations/versions
      : line.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((s) => s.trim()).filter(Boolean),
  );
  return bulletList(items.map((i) => i.replace(/\s*\.\s*$/, "")));
}

/** Lines a comment may contain besides bullets: headers, quotes, rules, the marker. */
const ALLOWED_NON_BULLET = /^(\*\*|#{1,6}\s|>|---|\||`eod:)/;

/** Prose paragraphs that slipped into a comment — eod_post refuses these. */
export function proseLines(comment: string): string[] {
  return comment
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^([-*•]|\d+[.)])\s+/.test(l) && !ALLOWED_NON_BULLET.test(l));
}

// matches "Test scenarios", "Testsenarios", "Test Senarios" — org fields carry typos
const SCENARIO_NAME_RE = /test.{0,3}enario/i;
const AC_NAME_RE = /acceptance.{0,3}criteria/i;

/**
 * Which work-item FIELD holds test scenarios / acceptance criteria for this type.
 * Explicit rules mapping wins; otherwise discover from the type's own field list —
 * static defaults only know Agile templates, and custom processes are the norm.
 */
export async function resolveSectionField(
  ado: Pick<AdoClient, "getTypeFields">,
  rules: Rules,
  type: string | undefined,
  kind: "testScenarios" | "acceptanceCriteria",
  project?: string,
): Promise<string | undefined> {
  if (!type) return undefined;
  const mapped = (kind === "testScenarios" ? rules.testScenarioField : rules.acceptanceCriteriaField)?.[type];
  if (mapped) return mapped;
  const re = kind === "testScenarios" ? SCENARIO_NAME_RE : AC_NAME_RE;
  const fields = await Promise.resolve()
    .then(() => ado.getTypeFields(type, project))
    .catch(() => [] as Array<{ name: string; referenceName: string }>);
  return fields.find((f) => re.test(f.name) || re.test(f.referenceName))?.referenceName || undefined;
}

/**
 * Fields the process template demands that the caller has not supplied.
 * Checked BEFORE the create so the failure names every field instead of coming back
 * as a truncated TF401320 one field at a time. Fields ADO fills itself (defaults,
 * system fields set on create) are not the caller's problem.
 */
const SELF_FILLED = new Set([
  "System.Id", "System.Rev", "System.AreaPath", "System.IterationPath", "System.WorkItemType",
  "System.State", "System.Reason", "System.CreatedBy", "System.CreatedDate",
  "System.ChangedBy", "System.ChangedDate", "System.TeamProject", "System.Title",
]);

export function missingRequiredFields(
  typeFields: Array<{ name: string; referenceName: string; alwaysRequired: boolean; defaultValue: unknown }>,
  supplied: Record<string, unknown>,
): Array<{ field: string; name: string }> {
  return typeFields
    .filter((f) => f.alwaysRequired && !SELF_FILLED.has(f.referenceName))
    .filter((f) => f.defaultValue === null || f.defaultValue === undefined || f.defaultValue === "")
    .filter((f) => {
      const v = supplied[f.referenceName];
      return v === undefined || v === null || v === "";
    })
    .map((f) => ({ field: f.referenceName, name: f.name }));
}

/** A comment must never carry a test-scenarios section when the type has a real field for it. */
export const SCENARIO_HEADING_RE = /^(#{1,6}\s*|\*\*)test.{0,3}enarios?/im;

// Legacy: comments posted before v0.5.1 carry a visible `eod:<date>:` footer. Still
// matched so those tickets keep being updated instead of gaining a duplicate — but
// nothing writes it any more (the id is recorded locally, see rules.rememberComment).
export const EOD_MARKER_RE = /`eod:(\d{4}-\d{2}-\d{2}):[^`]*`/;

/** The generated header, e.g. "**implementation** (2h)" — used to recognise our own comment. */
const EOD_HEADER_RE = /^\*\*[^*\n]+\*\*\s*\(\d+(?:\.\d+)?h\)\s*$/m;

/**
 * Today's already-posted eod comment, if any.
 * knownId (from the local record) is authoritative; otherwise fall back to a comment
 * written by this user on that local day that still looks like one of ours. The
 * fallback deliberately errs toward "not found" — a duplicate comment beats
 * overwriting somebody's hand-written note.
 */
export function findEodComment<T extends { id?: number; text: string; createdBy?: string; createdDate?: string }>(
  comments: T[],
  date: string,
  opts: { knownId?: number; author?: string; dayStartMs?: number; dayEndMs?: number } = {},
): T | undefined {
  if (opts.knownId !== undefined) {
    const byId = comments.find((c) => c.id === opts.knownId);
    if (byId) return byId;
  }
  const legacy = comments.find((c) => c.text.match(EOD_MARKER_RE)?.[0].startsWith(`\`eod:${date}:`));
  if (legacy) return legacy;
  if (!opts.author || opts.dayStartMs === undefined) return undefined;
  return comments.find((c) => {
    if (c.createdBy !== opts.author || !c.createdDate) return false;
    const t = new Date(c.createdDate).getTime();
    if (isNaN(t) || t < opts.dayStartMs! || t >= (opts.dayEndMs ?? Infinity)) return false;
    return EOD_HEADER_RE.test(c.text);
  });
}

/** Attribution: explicit → evidence ticket ids. Groups sessions per ticket. */
export function attribute(input: DraftInput): Map<number, SessionRecord[]> {
  const { evidence, tickets } = input;
  const byTicket = new Map<number, SessionRecord[]>();
  const add = (id: number, s?: SessionRecord) => {
    if (!byTicket.has(id)) byTicket.set(id, []);
    if (s) byTicket.get(id)!.push(s);
  };
  for (const s of evidence.sessions) {
    for (const t of s.ticketIds) add(Number(t), s);
  }
  // git-derived ids (branch names, commit messages) — attach sessions by cwd overlap
  for (const g of evidence.git) {
    for (const t of g.ticketIds) {
      const id = Number(t);
      const related = evidence.sessions.filter((s) => pathsOverlap(s.cwd, g.repo));
      if (!byTicket.has(id)) byTicket.set(id, []);
      for (const s of related) if (!byTicket.get(id)!.includes(s)) byTicket.get(id)!.push(s);
    }
  }
  // explicit tickets from the user always exist, even with no matched session
  for (const id of tickets ?? []) add(id);
  return byTicket;
}

export function unattributedSessions(evidence: DayEvidence, attributed: Map<number, SessionRecord[]>): SessionRecord[] {
  const used = new Set<SessionRecord>();
  for (const list of attributed.values()) for (const s of list) used.add(s);
  return evidence.sessions.filter((s) => !used.has(s));
}

function pct(completed: number | undefined, remaining: number | undefined): number | null {
  const c = completed ?? 0;
  const r = remaining;
  if (r === undefined || r === null || c + r === 0) return null;
  return Math.round((c / (c + r)) * 100);
}

/** Split a day's capped hours across tickets by session weight (prompt count). */
export function splitHours(byTicket: Map<number, SessionRecord[]>, rules: Rules): Map<number, number> {
  const totalMinutes = new Map<number, number>();
  // a session on N tickets contributes 1/N of its minutes to each
  const shares = new Map<SessionRecord, number>();
  for (const [, list] of byTicket) for (const s of list) shares.set(s, (shares.get(s) ?? 0) + 1);
  for (const [id, list] of byTicket) {
    let m = 0;
    for (const s of list) m += s.activeMinutes / (shares.get(s) ?? 1);
    totalMinutes.set(id, m);
  }
  // cap the DAY, not each ticket: scale down proportionally if the sum exceeds maxPerDay
  const sumH = [...totalMinutes.values()].reduce((a, b) => a + b, 0) / 60;
  const scale = sumH > rules.hours.maxPerDay ? rules.hours.maxPerDay / sumH : 1;
  const out = new Map<number, number>();
  for (const [id, m] of totalMinutes) out.set(id, roundAndCapHours(m * scale, rules));
  // per-ticket rounding can push the SUM back over the cap (6.75→7.0, 7.25→7.5 = 14.5 on
  // a 14h day) — shave steps off the largest tickets until the day fits again
  const step = rules.hours.roundToHours;
  let total = [...out.values()].reduce((a, b) => a + b, 0);
  while (total > rules.hours.maxPerDay + 1e-9) {
    const [bigId] = [...out.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
    if ((out.get(bigId) ?? 0) < step) break; // nothing left to shave
    out.set(bigId, +(out.get(bigId)! - step).toFixed(4));
    total = +(total - step).toFixed(4);
  }
  return out;
}

export async function buildDrafts(ado: AdoClient, rules: Rules, input: DraftInput): Promise<{ drafts: TicketDraft[]; unattributed: SessionRecord[]; gitOnly: string[] }> {
  const byTicket = attribute(input);
  const hoursByTicket = splitHours(byTicket, rules);
  const drafts: TicketDraft[] = [];
  const callerEmail = rules.applies.onlyMyTickets ? (await ado.whoAmI()).email.toLowerCase() : null;

  for (const [ticketId, sessions] of byTicket) {
    const draft: TicketDraft = {
      ticketId,
      sessions: sessions.map((s) => s.sessionId),
      hours: hoursByTicket.get(ticketId) ?? 0,
      commentMarkdown: "",
      date: input.evidence.date,
      missingSections: [],
      autoFilled: [],
      fieldAppends: [],
    };
    try {
      const wi = await ado.getWorkItem(ticketId);
      applyWorkItem(draft, wi, rules, callerEmail);
      const comments = await ado.getComments(ticketId, draft.project);
      const existing = findEodComment(comments, input.evidence.date, {
        knownId: input.knownCommentIds?.[ticketId],
        author: input.authorDisplayName,
        dayStartMs: input.dayStartMs,
        dayEndMs: input.dayEndMs,
      });
      if (existing) draft.existingEodComment = { id: existing.id, date: input.evidence.date };
      await applyCompletion(draft, wi, ado, rules, input);
      const scenarioField = await resolveSectionField(ado, rules, draft.workItemType, "testScenarios", draft.project);
      buildComment(draft, sessions, input, rules, scenarioField);
    } catch (e: any) {
      draft.error = e.message ?? String(e);
    }
    drafts.push(draft);
  }
  return {
    drafts,
    unattributed: unattributedSessions(input.evidence, byTicket),
    gitOnly: input.evidence.git.filter((g) => !g.hasSession).map((g) => `${g.repo} (${g.commits.length} commits, no session — Cursor/Antigravity gap?)`),
  };
}

function applyWorkItem(draft: TicketDraft, wi: WorkItem, rules: Rules, callerEmail: string | null): void {
  const f = wi.fields;
  draft.rev = wi.rev;
  draft.project = f["System.TeamProject"];
  draft.title = f["System.Title"];
  draft.workItemType = f["System.WorkItemType"];
  draft.currentState = f["System.State"];
  draft.currentCompleted = f["Microsoft.VSTS.Scheduling.CompletedWork"];
  draft.currentRemaining = f["Microsoft.VSTS.Scheduling.RemainingWork"];

  // rules: who/what/where
  const a = rules.applies;
  const project = f["System.TeamProject"];
  if (a.projects.length && !a.projects.includes(project)) draft.error = `rules: project "${project}" is not in applies.projects`;
  if (a.workItemTypes.length && !a.workItemTypes.includes(draft.workItemType!)) draft.error = `rules: work item type "${draft.workItemType}" is not in applies.workItemTypes`;
  if (a.blockStates.includes(draft.currentState!)) draft.error = `rules: state "${draft.currentState}" is blocked`;
  if (callerEmail) {
    const assigned = (f["System.AssignedTo"]?.uniqueName ?? f["System.AssignedTo"]?.mail ?? "").toLowerCase();
    if (assigned && assigned !== callerEmail)
      draft.error = `rules: applies.onlyMyTickets — ticket is assigned to ${f["System.AssignedTo"]?.displayName ?? assigned}, not you`;
  }

  // cumulative hours — read then add, never overwrite
  draft.newCompleted = (draft.currentCompleted ?? 0) + draft.hours;
  if (draft.currentRemaining !== undefined && draft.currentRemaining !== null) {
    draft.newRemaining = Math.max(0, draft.currentRemaining - draft.hours);
  }
  draft.percentBefore = pct(draft.currentCompleted, draft.currentRemaining);
  draft.percentAfter = pct(draft.newCompleted, draft.newRemaining);
}

async function applyCompletion(draft: TicketDraft, wi: WorkItem, ado: AdoClient, rules: Rules, input: DraftInput): Promise<void> {
  const completion = input.completion?.ticketId === draft.ticketId ? input.completion : undefined;
  if (!completion) {
    draft.proposedState = null;
    return;
  }
  draft.allowedStates = await ado.getAllowedStates(draft.workItemType!, draft.project).catch(() => []);
  const target = rules.completion.maxProposedState;
  draft.proposedState = draft.allowedStates.includes(target) ? target : draft.allowedStates.find((s) => /resolved|done/i.test(s)) ?? null;

  if (completion.tester) {
    const identity = await ado.resolveIdentity(completion.tester);
    draft.signoff = identity
      ? { tester: completion.tester, resolved: true, displayName: identity.displayName, identityId: identity.id }
      : { tester: completion.tester, resolved: false };
    // fill the org's Tester identity field too, when the rules name one
    if (identity && rules.testerField) draft.setFields = { ...draft.setFields, [rules.testerField]: completion.tester };
  } else if (rules.completion.requireTester) {
    draft.missingSections.push("tester (completion proposed — who tested this?)");
  }
}

function render(template: string, vars: Record<string, string | string[] | Array<Record<string, string>>>): string {
  // ponytail: 20-line mustache subset — {{key}}, {{#list}}…{{/list}} with {{.}} or {{field}}
  let out = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, block) => {
    const list = vars[key];
    if (!Array.isArray(list) || !list.length) return "";
    return list
      .map((item) =>
        typeof item === "string"
          ? block.replace(/\{\{\.\}\}/g, item)
          : block.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => item[k] ?? ""),
      )
      .join("");
  });
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return typeof v === "string" ? v : "";
  });
  return out;
}

/** Factual summary from the day's own evidence — commit subjects first, session shape as fallback. */
function autoSummary(draft: TicketDraft, sessions: SessionRecord[], input: DraftInput): string {
  const commits = [
    ...new Set(
      input.evidence.git
        .filter((g) => g.ticketIds.includes(String(draft.ticketId)) || sessions.some((s) => pathsOverlap(s.cwd, g.repo)))
        .flatMap((g) => g.commits),
    ),
  ];
  const files = new Set(sessions.flatMap((s) => s.files)).size;
  // one bullet per commit — comments are scannable lists, never paragraphs
  const parts: string[] = commits.slice(0, 6);
  if (commits.length > 6) parts.push(`+${commits.length - 6} more commits`);
  if (sessions.length) parts.push(`${sessions.length} working session${sessions.length > 1 ? "s" : ""}, ${files} file${files === 1 ? "" : "s"} touched`);
  if (!parts.length && draft.title) parts.push(`Worked on: ${draft.title}`);
  return bulletList(parts);
}

function buildComment(draft: TicketDraft, sessions: SessionRecord[], input: DraftInput, rules: Rules, scenarioField?: string): void {
  const workTypes = [...new Set(sessions.map((s) => s.workType))];
  const repoRows = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].map((cwd) => ({
    name: cwd!.split("/").pop()!,
    detail: `${sessions.filter((s) => s.cwd === cwd).flatMap((s) => s.files).length} files`,
  }));

  // Every section is filled from evidence (notes from the live conversation win when
  // given). The user edits the shown draft — they are never interrogated section by
  // section. autoFilled records what was generated so the assistant can point at it.
  let summary = input.notes ? toBullets(input.notes) : "";
  if (!summary) {
    summary = autoSummary(draft, sessions, input);
    if (summary) draft.autoFilled.push("summary");
  }
  const next = draft.proposedState
    ? "None — work complete, pending tester sign-off."
    : `Continue: ${draft.title ?? "current work"}.`;
  draft.autoFilled.push("next");

  // Test scenarios belong in the org's dedicated FIELD (mistake seen live: they were
  // pasted into the comment). Route them; the comment only carries them when the type
  // truly has no such field (explicit mapping AND discovery both came up empty).
  const scenarios = input.testScenarios ?? [];
  if (scenarios.length && scenarioField) {
    draft.fieldAppends.push({ field: scenarioField, markdown: bulletList(scenarios) });
  }

  const inComment = scenarioField ? [] : scenarios; // field-routed scenarios stay out of the comment
  const vars: Record<string, any> = {
    date: input.evidence.date,
    workType: workTypes.join("+") || "implementation",
    hours: String(draft.hours),
    summary,
    repos: repoRows,
    issues: [],
    testScenarios: inComment, // legacy templates that still loop over it keep working
    testScenariosSection: inComment.length ? `**Test scenarios**\n${bulletList(inComment)}\n` : "",
    next,
  };

  // Only what nothing can derive is still flagged: a summary with zero evidence, and
  // test scenarios when completion is proposed (the sign-off needs real ones).
  for (const section of rules.comment.required) {
    if (section === "summary" && !vars.summary) draft.missingSections.push("summary (no evidence found for this ticket today)");
    if (section === "testScenarios" && draft.proposedState && !scenarios.length)
      draft.missingSections.push("testScenarios (completion proposed — how was this verified?)");
  }

  let body = render(rules.comment.template, vars);
  if (draft.proposedState && draft.signoff?.resolved) {
    const mention = draft.signoff.identityId ? `@<${draft.signoff.identityId}>` : `@${draft.signoff.tester}`;
    body += "\n" + render(rules.comment.signoffTemplate, { testerMention: mention });
  } else if (draft.proposedState && draft.signoff && !draft.signoff.resolved) {
    body += "\n" + render(rules.comment.signoffTemplate, { testerMention: `@${draft.signoff.tester}` }) + "\n\n> ⚠ identity not resolved — mention will not notify";
  }
  // no marker footer — the posted comment id is recorded locally instead, so the
  // ticket shows only what a human wants to read
  draft.commentMarkdown = body.trimEnd();
}
