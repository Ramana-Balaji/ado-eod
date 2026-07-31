import { AdoClient, WorkItem } from "./ado.js";
import { Rules } from "./rules.js";
import { DayEvidence, SessionRecord, roundAndCapHours } from "./worklog.js";

export interface TicketDraft {
  ticketId: number;
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
  missingSections: string[]; // required sections the evidence couldn't fill → ask user
  fieldAppends: Array<{ field: string; markdown: string }>;
  signoff?: { tester: string; resolved: boolean; displayName?: string; identityId?: string };
  existingEodComment?: { id: number; date: string }; // idempotency marker found
}

export interface DraftInput {
  evidence: DayEvidence;
  notes?: string; // live-conversation context from the assistant
  tickets?: number[]; // explicit ticket ids from the user's message
  completion?: { ticketId: number; tester?: string }; // user says work is complete
}

const EOD_MARKER_RE = /^<!-- eod:(\d{4}-\d{2}-\d{2}):/;

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
      const related = evidence.sessions.filter((s) => s.cwd && (s.cwd.startsWith(g.repo) || g.repo.startsWith(s.cwd)));
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

function buildComment(draft: TicketDraft, sessions: SessionRecord[], input: DraftInput, rules: Rules): void {
  const workTypes = [...new Set(sessions.map((s) => s.workType))];
  const repoRows = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].map((cwd) => ({
    name: cwd!.split("/").pop()!,
    detail: `${sessions.filter((s) => s.cwd === cwd).flatMap((s) => s.files).length} files`,
  }));

  // What the evidence alone can fill; summary/issues/next/testScenarios come from `notes`
  // (the live conversation) — the assistant fills them, we only validate.
  const vars: Record<string, any> = {
    date: input.evidence.date,
    workType: workTypes.join("+") || "implementation",
    hours: String(draft.hours),
    summary: input.notes ?? "",
    repos: repoRows,
    issues: [],
    testScenarios: [],
    next: "",
  };

  for (const section of rules.comment.required) {
    if (section === "summary" && !vars.summary) draft.missingSections.push("summary");
    if (section === "next" && !vars.next) draft.missingSections.push("next");
    if (section === "testScenarios" && !vars.testScenarios.length) draft.missingSections.push("testScenarios");
    if (section === "description" || section === "acceptanceCriteria") {
      // required as field appends too; flagged for the assistant to supply
      draft.missingSections.push(section);
    }
  }

  const marker = `<!-- eod:${input.evidence.date}:${draft.sessions.join(",")} -->\n`;
  let body = render(rules.comment.template, vars);
  if (draft.proposedState && draft.signoff?.resolved) {
    const mention = draft.signoff.identityId ? `@<${draft.signoff.identityId}>` : `@${draft.signoff.tester}`;
    body += "\n" + render(rules.comment.signoffTemplate, { testerMention: mention });
  } else if (draft.proposedState && draft.signoff && !draft.signoff.resolved) {
    body += "\n" + render(rules.comment.signoffTemplate, { testerMention: `@${draft.signoff.tester}` }) + "\n\n> ⚠ identity not resolved — mention will not notify";
  }
  draft.commentMarkdown = marker + body;
}
