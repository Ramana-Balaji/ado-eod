import { AdoClient, WorkItem } from "./ado.js";
import { Rules } from "./rules.js";
import { DayEvidence, SessionRecord, roundAndCapHours, pathsOverlap } from "./worklog.js";

export interface TicketDraft {
  ticketId: number;
  /** System.Rev at draft time — eod_post requires it for its concurrent-edit guard. */
  rev?: number;
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
}

// ADO strips HTML comments (<!-- -->) from Markdown comments, so the idempotency marker
// is a visible footer in inline code — quiet, greppable, and it survives sanitization.
export const EOD_MARKER_RE = /`eod:(\d{4}-\d{2}-\d{2}):[^`]*`/;

export function eodMarker(date: string, sessionIds: string[]): string {
  return `\`eod:${date}:${sessionIds.map((s) => s.slice(0, 8)).join(",")}\``;
}

export function findEodComment<T extends { text: string }>(comments: T[], date: string): T | undefined {
  return comments.find((c) => {
    const m = c.text.match(EOD_MARKER_RE);
    return m?.[0].startsWith(`\`eod:${date}:`);
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
      missingSections: [],
      autoFilled: [],
      fieldAppends: [],
    };
    try {
      const wi = await ado.getWorkItem(ticketId);
      applyWorkItem(draft, wi, rules, callerEmail);
      const comments = await ado.getComments(ticketId);
      for (const c of comments) {
        const m = c.text.match(EOD_MARKER_RE);
        if (m && m[1] === input.evidence.date) draft.existingEodComment = { id: c.id, date: m[1] };
      }
      await applyCompletion(draft, wi, ado, rules, input);
      buildComment(draft, sessions, input, rules);
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
  draft.allowedStates = await ado.getAllowedStates(draft.workItemType!).catch(() => []);
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
  const parts: string[] = [];
  if (commits.length) parts.push(`Commits: ${commits.slice(0, 5).join("; ")}${commits.length > 5 ? ` (+${commits.length - 5} more)` : ""}.`);
  if (sessions.length) parts.push(`${sessions.length} working session${sessions.length > 1 ? "s" : ""}, ${files} file${files === 1 ? "" : "s"} touched.`);
  if (!parts.length && draft.title) parts.push(`Worked on: ${draft.title}.`);
  return parts.join(" ");
}

function buildComment(draft: TicketDraft, sessions: SessionRecord[], input: DraftInput, rules: Rules): void {
  const workTypes = [...new Set(sessions.map((s) => s.workType))];
  const repoRows = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].map((cwd) => ({
    name: cwd!.split("/").pop()!,
    detail: `${sessions.filter((s) => s.cwd === cwd).flatMap((s) => s.files).length} files`,
  }));

  // Every section is filled from evidence (notes from the live conversation win when
  // given). The user edits the shown draft — they are never interrogated section by
  // section. autoFilled records what was generated so the assistant can point at it.
  let summary = input.notes ?? "";
  if (!summary) {
    summary = autoSummary(draft, sessions, input);
    if (summary) draft.autoFilled.push("summary");
  }
  const next = draft.proposedState
    ? "None — work complete, pending tester sign-off."
    : `Continue: ${draft.title ?? "current work"}.`;
  draft.autoFilled.push("next");

  const vars: Record<string, any> = {
    date: input.evidence.date,
    workType: workTypes.join("+") || "implementation",
    hours: String(draft.hours),
    summary,
    repos: repoRows,
    issues: [],
    testScenarios: [],
    next,
  };

  // Only what nothing can derive is still flagged: a summary with zero evidence, and
  // test scenarios when completion is proposed (the sign-off needs real ones).
  for (const section of rules.comment.required) {
    if (section === "summary" && !vars.summary) draft.missingSections.push("summary (no evidence found for this ticket today)");
    if (section === "testScenarios" && draft.proposedState && !vars.testScenarios.length)
      draft.missingSections.push("testScenarios (completion proposed — how was this verified?)");
  }

  let body = render(rules.comment.template, vars);
  if (draft.proposedState && draft.signoff?.resolved) {
    const mention = draft.signoff.identityId ? `@<${draft.signoff.identityId}>` : `@${draft.signoff.tester}`;
    body += "\n" + render(rules.comment.signoffTemplate, { testerMention: mention });
  } else if (draft.proposedState && draft.signoff && !draft.signoff.resolved) {
    body += "\n" + render(rules.comment.signoffTemplate, { testerMention: `@${draft.signoff.tester}` }) + "\n\n> ⚠ identity not resolved — mention will not notify";
  }
  draft.commentMarkdown = body.trimEnd() + "\n\n---\n" + eodMarker(input.evidence.date, draft.sessions);
}
