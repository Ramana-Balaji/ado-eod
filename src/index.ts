import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRules } from "./rules.js";
import { collectDay, localToday } from "./worklog.js";
import { AdoClient } from "./ado.js";
import { buildDrafts, EOD_MARKER_RE, findEodComment } from "./draft.js";
import { report, ReportView } from "./report.js";

const { rules, sources, configErrors } = loadRules();
const ado = new AdoClient(rules);

/** ADO-touching tools refuse with a pointer to setup instead of a stack trace. */
function notReady() {
  if (!configErrors.length) return null;
  return json({ error: "ado-eod is not configured", fix: configErrors });
}

// "today" is the user's LOCAL day — toISOString() would lose evenings east of UTC
const today = localToday;

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export const server = new McpServer({ name: "ado-eod", version: "0.1.0" });

server.tool(
  "eod_worklog",
  "Collect today's (or a given day's) work evidence from Claude Code / Codex / Cursor histories and git. Read-only; no Azure DevOps calls.",
  { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
  async ({ date }) => json(await collectDay(date ?? today(), rules)),
);

server.tool(
  "eod_draft",
  "Build per-ticket EOD drafts: comment markdown, cumulative hours with % complete, proposed state, field appends. Reads ADO, writes NOTHING. Show the result to the user; missingSections must be filled (via notes or user answers) before eod_post.",
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    tickets: z.array(z.number()).optional().describe("Explicit work item ids from the user's message"),
    notes: z.string().optional().describe("Summary of the day's work from the live conversation"),
    completion: z
      .object({ ticketId: z.number(), tester: z.string().optional() })
      .optional()
      .describe("Set ONLY when the user says the work is complete; tester = who verified it"),
  },
  async ({ date, tickets, notes, completion }) => {
    const blocked = notReady();
    if (blocked) return blocked;
    const evidence = await collectDay(date ?? today(), rules);
    const result = await buildDrafts(ado, rules, { evidence, tickets, notes, completion });
    return json(result);
  },
);

server.tool(
  "eod_status",
  "Diagnostics: auth identity, org/project, rules in force and their source files, which IDE histories exist. Run this when anything misbehaves.",
  {},
  async () => {
    let auth: unknown;
    if (!rules.ado.org) {
      auth = { error: "no org configured — run: npx ado-eod setup --org <yourorg>" };
    } else {
      try {
        auth = await ado.whoAmI();
      } catch (e: any) {
        auth = { error: e.message?.slice(0, 300) ?? String(e) };
      }
    }
    return json({
      auth,
      org: rules.ado.org || "(not set)",
      project: rules.ado.project || "(not set)",
      configErrors,
      ruleSources: sources,
      histories: {
        "claude-code": existsSync(join(homedir(), ".claude", "projects")),
        codex: existsSync(join(homedir(), ".codex", "sessions")),
        cursor: existsSync(join(homedir(), ".cursor", "projects")),
        antigravity: "not minable (protobuf) — covered via git + live conversation",
      },
      commentsMarkdownSupported: ado.commentsMarkdownSupported ?? "not yet probed (first post decides)",
      patFallbackActive: Boolean(process.env.ADO_EOD_PAT),
    });
  },
);

server.tool(
  "eod_report",
  "Admin rollups over Azure DevOps (read-only): progress | people | breakdown | timeline for a project and date range.",
  {
    project: z.string().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    person: z.string().optional(),
    view: z.enum(["progress", "people", "breakdown", "timeline"]),
  },
  async (args) => {
    const blocked = notReady();
    if (blocked) return blocked;
    return json(await report(ado, { ...args, project: args.project ?? rules.ado.project, view: args.view as ReportView }));
  },
);

server.tool(
  "eod_post",
  "Write confirmed EOD updates to Azure DevOps. ONLY call after the user explicitly confirmed the exact draft in chat. Refuses without confirmed=true. Skips hour fields when the day's marker comment already exists (idempotent).",
  {
    confirmed: z.literal(true).describe("Must be literally true — the user saw the draft and said yes"),
    updates: z.array(
      z.object({
        ticketId: z.number(),
        rev: z.number().describe("System.Rev read at draft time — write fails loudly if the item changed since"),
        commentMarkdown: z.string(),
        completedWork: z.number().optional(),
        remainingWork: z.number().optional(),
        state: z.string().optional(),
        fieldAppends: z.array(z.object({ field: z.string(), markdown: z.string() })).optional(),
      }),
    ),
  },
  async ({ updates }) => {
    const blocked = notReady();
    if (blocked) return blocked;
    const results: unknown[] = [];
    for (const u of updates) {
      try {
        // hard server-side guards — not the assistant's job to remember these
        if (u.state && ["Closed", "Removed"].includes(u.state)) {
          results.push({ ticketId: u.ticketId, ok: false, error: `state "${u.state}" is never set by this tool — the tester closes after confirming` });
          continue;
        }
        if (u.state && rules.applies.blockStates.includes(u.state)) {
          results.push({ ticketId: u.ticketId, ok: false, error: `state "${u.state}" is blocked by rules (applies.blockStates)` });
          continue;
        }

        // idempotency: a same-day marker means UPDATE that comment and skip hour fields
        const comments = await ado.getComments(u.ticketId);
        const markerDate = u.commentMarkdown.match(EOD_MARKER_RE)?.[1];
        const dup = markerDate ? findEodComment(comments, markerDate) : undefined;
        const skipHours = Boolean(dup);

        if (dup) await ado.updateComment(u.ticketId, dup.id, u.commentMarkdown, rules.comment.format);
        else await ado.addComment(u.ticketId, u.commentMarkdown, rules.comment.format);

        const fields: Record<string, any> = {};
        const markdownFields: string[] = [];
        if (!skipHours && rules.fields.completedWork && u.completedWork !== undefined)
          fields["Microsoft.VSTS.Scheduling.CompletedWork"] = u.completedWork;
        if (!skipHours && rules.fields.remainingWork && u.remainingWork !== undefined)
          fields["Microsoft.VSTS.Scheduling.RemainingWork"] = u.remainingWork;
        if (rules.fields.state && u.state) fields["System.State"] = u.state;
        for (const fa of u.fieldAppends ?? []) {
          // read-then-append, never overwrite
          const wi = await ado.getWorkItem(u.ticketId);
          const current = wi.fields[fa.field] ?? "";
          fields[fa.field] = current ? `${current}\n\n---\n\n${fa.markdown}` : fa.markdown;
          markdownFields.push(fa.field);
        }
        if (Object.keys(fields).length) await ado.updateWorkItem(u.ticketId, u.rev, fields, markdownFields);
        results.push({ ticketId: u.ticketId, ok: true, skippedHours: skipHours });
      } catch (e: any) {
        results.push({ ticketId: u.ticketId, ok: false, error: e.message?.slice(0, 400) ?? String(e) });
      }
    }
    return json(results);
  },
);

server.tool(
  "eod_create",
  "Create a new work item. ONLY call after the user explicitly confirmed the exact title, type, and description in chat. Refuses without confirmed=true.",
  {
    confirmed: z.literal(true).describe("Must be literally true — the user saw title/type/description and said yes"),
    type: z.string().describe("Work item type, e.g. Feature, Task, Bug — must exist in the project"),
    title: z.string(),
    descriptionMarkdown: z.string().optional(),
    assignToSelf: z.boolean().optional().describe("Assign to the authenticated user"),
    tags: z.array(z.string()).optional(),
  },
  async ({ type, title, descriptionMarkdown, assignToSelf, tags }) => {
    const blocked = notReady();
    if (blocked) return blocked;
    const extra: Record<string, any> = {};
    if (assignToSelf) extra["System.AssignedTo"] = (await ado.whoAmI()).email;
    if (tags?.length) extra["System.Tags"] = tags.join("; ");
    const wi = await ado.createWorkItem(type, title, descriptionMarkdown, extra);
    return json({
      id: wi.id,
      rev: wi.rev,
      url: `https://dev.azure.com/${rules.ado.org}/${encodeURIComponent(rules.ado.project)}/_workitems/edit/${wi.id}`,
    });
  },
);

export async function main() {
  await server.connect(new StdioServerTransport());
}
