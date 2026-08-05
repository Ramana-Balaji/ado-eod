import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRules, writeUserRules } from "./rules.js";
import { parseAdoInput } from "./setup.js";
import { collectDay, localToday } from "./worklog.js";
import { AdoClient } from "./ado.js";
import { buildDrafts, bulletList, resolveSectionField, SCENARIO_HEADING_RE, EOD_MARKER_RE, findEodComment } from "./draft.js";
import { report, ReportView } from "./report.js";

// let, not const — eod_configure reloads these in place so a fresh install
// works in the same chat session without an IDE restart
let { rules, sources, configErrors } = loadRules();
let ado = new AdoClient(rules);

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

// The workflow contract travels WITH the server — every MCP client gets it at initialize,
// even ones setup never wrote a skill file for. The per-IDE SKILL.md is the richer layer.
const INSTRUCTIONS = `End-of-day Azure DevOps ticket updates. Trigger phrases: "update my ticket", "log my day", or a pasted dev.azure.com work item link.

First run: if any tool reports "not configured", ask the user to paste their Azure DevOps address (https://dev.azure.com/<org>/<project>) and call eod_configure with it — no terminal needed. Sign-in opens in the browser on the first Azure DevOps call.

Daily flow — follow this order:
1. eod_worklog for the day's evidence.
2. eod_draft (tickets the user named; write "notes" YOURSELF — a 2-4 sentence factual summary from the worklog evidence and the live conversation, do NOT ask the user what they did; "completion" ONLY if the user said the work is complete, with "tester" if they named who tested; how it was verified goes in "testScenarios" — the server routes it to the org's field, never put it in notes).
3. Show the full draft in chat IMMEDIATELY — no questions first: comment markdown, "Completed Xh → Yh · N% → M% done", proposed state, field changes, plus unattributed sessions. Sections in autoFilled were generated from evidence — the user edits if needed.
4. Ask ONLY for what is in missingSections (rare: tester on completion, or zero evidence). Everything else ships as drafted.
5. Only after an explicit yes: eod_post with confirmed=true and the exact values shown (with any edits the user made). Never post unreviewed.

Ticket creation (eod_create): only on explicit request, after showing type+title+description and getting a yes. Acceptance criteria go in the acceptanceCriteria arg and test scenarios in the testScenarios arg — NEVER inside descriptionMarkdown or a comment; the server routes them to the org's dedicated fields and rejects descriptions that embed them.

Admin questions ("how did <project> go this week", "what has <person> been working on") → eod_report with view progress|people|breakdown|timeline.

Server-enforced (don't fight): hours cumulative with a daily cap; Closed/Removed never set — the tester closes; same-day re-runs update the existing comment idempotently. Any tool failure → run eod_status and relay its fix.`;

export const server = new McpServer({ name: "ado-eod", version: "0.3.3" }, { instructions: INSTRUCTIONS });

server.tool(
  "eod_worklog",
  "Collect today's (or a given day's) work evidence from Claude Code / Codex / Cursor histories and git. Read-only; no Azure DevOps calls.",
  { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
  async ({ date }) => json(await collectDay(date ?? today(), rules)),
);

server.tool(
  "eod_draft",
  "Build per-ticket EOD drafts: comment markdown, cumulative hours with % complete, proposed state, field appends. Reads ADO, writes NOTHING. Sections are auto-filled from evidence (autoFilled lists them) — show the draft immediately; only ask the user about missingSections entries (rare).",
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    tickets: z.array(z.number()).optional().describe("Explicit work item ids from the user's message"),
    notes: z.string().optional().describe("Summary of the day's work from the live conversation"),
    completion: z
      .object({ ticketId: z.number(), tester: z.string().optional() })
      .optional()
      .describe("Set ONLY when the user says the work is complete; tester = who verified it"),
    testScenarios: z
      .array(z.string())
      .optional()
      .describe("How the work was verified, as short bullets — the server routes these to the org's test-scenario FIELD; never paste them into notes or the comment"),
  },
  async ({ date, tickets, notes, completion, testScenarios }) => {
    const blocked = notReady();
    if (blocked) return blocked;
    const evidence = await collectDay(date ?? today(), rules);
    const result = await buildDrafts(ado, rules, { evidence, tickets, notes, completion, testScenarios });
    return json(result);
  },
);

server.tool(
  "eod_configure",
  "First-run configuration: save the user's Azure DevOps org/project from a pasted dev.azure.com address. Call when any tool reports 'not configured'. Takes effect immediately — no restart. Overwrites ~/.ado-eod/rules.yaml, so only call with an address the user gave in this conversation.",
  {
    adoUrl: z.string().describe("What the user pasted — a dev.azure.com/<org>/<project> URL, a <org>.visualstudio.com URL, or just the org name"),
    project: z.string().optional().describe("Project name, if the user gave it separately"),
  },
  async ({ adoUrl, project }) => {
    const parsed = parseAdoInput(adoUrl);
    if (!parsed.org)
      return json({ ok: false, error: `could not find an organization in "${adoUrl}" — ask the user for the address of the page where their tickets live (https://dev.azure.com/<org>/<project>)` });
    const path = writeUserRules(parsed.org, project ?? parsed.project);
    ({ rules, sources, configErrors } = loadRules());
    ado = new AdoClient(rules);
    return json({
      ok: true,
      org: rules.ado.org,
      project: rules.ado.project || "(not set — eod_report and eod_create need one)",
      savedTo: path,
      configErrors,
      note: "sign-in happens in the browser on the first Azure DevOps call — tell the user to watch for a browser window",
    });
  },
);

server.tool(
  "eod_status",
  "Diagnostics: auth identity, org/project, rules in force and their source files, which IDE histories exist. Run this when anything misbehaves.",
  {},
  async () => {
    let auth: unknown;
    if (!rules.ado.org) {
      auth = { error: "no org configured — ask the user for their Azure DevOps address and call eod_configure (or they can run: npx ado-eod setup)" };
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
        setFields: z
          .record(z.string(), z.any())
          .optional()
          .describe("Fields set directly (not appended) — e.g. the tester identity field on completion"),
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

        // the marker is what makes re-runs idempotent — a draft that lost it must not post,
        // or every retry would add a fresh comment and re-count the hours
        const markerDate = u.commentMarkdown.match(EOD_MARKER_RE)?.[1];
        if (!markerDate) {
          results.push({ ticketId: u.ticketId, ok: false, error: "commentMarkdown is missing its `eod:` marker — post the draft's comment unmodified (edits are fine, the marker line must stay)" });
          continue;
        }

        // concurrent-edit guard BEFORE we write anything: posting our own comment bumps
        // rev, so testing the draft-time rev inside the field PATCH would always fail
        const wi = await ado.getWorkItem(u.ticketId);
        if (wi.rev !== u.rev) {
          results.push({ ticketId: u.ticketId, ok: false, error: `ticket changed since draft (rev ${u.rev} → ${wi.rev}) — redraft with eod_draft and confirm again` });
          continue;
        }

        // hard rule, seen violated live twice: a comment must not carry a test-scenarios
        // section when the type has a real field for it — that's what eod_draft's
        // testScenarios arg is for
        if (SCENARIO_HEADING_RE.test(u.commentMarkdown)) {
          const sf = await resolveSectionField(ado, rules, wi.fields["System.WorkItemType"], "testScenarios");
          const appendsCoverIt = (u.fieldAppends ?? []).some((fa) => fa.field === sf);
          if (sf && !appendsCoverIt) {
            results.push({ ticketId: u.ticketId, ok: false, error: `this comment embeds a Test scenarios section, but this work item type stores them in the "${sf}" field — redraft with eod_draft's testScenarios arg (the server routes them) and confirm again` });
            continue;
          }
        }

        // idempotency: a same-day marker means UPDATE that comment and skip hour fields
        const comments = await ado.getComments(u.ticketId);
        const dup = findEodComment(comments, markerDate);
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
          // read-then-append, never overwrite (current values from the pre-check read)
          const current = wi.fields[fa.field] ?? "";
          fields[fa.field] = current ? `${current}\n\n---\n\n${fa.markdown}` : fa.markdown;
          markdownFields.push(fa.field);
        }
        for (const [k, v] of Object.entries(u.setFields ?? {})) {
          fields[k] = v;
          if (rules.fields.markdownFields?.includes(k)) markdownFields.push(k);
        }
        if (Object.keys(fields).length) {
          // our own comment just bumped rev — re-read so the PATCH's test op checks
          // against reality; the pre-check above already caught third-party edits
          const fresh = await ado.getWorkItem(u.ticketId);
          await ado.updateWorkItem(u.ticketId, fresh.rev, fields, markdownFields);
        }
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
    descriptionMarkdown: z.string().optional().describe("Narrative and links ONLY — acceptance criteria and test scenarios have their own args"),
    acceptanceCriteria: z.array(z.string()).optional().describe("Short bullets — the server routes these to the org's acceptance-criteria field"),
    testScenarios: z.array(z.string()).optional().describe("Short bullets — the server routes these to the org's test-scenario field"),
    assignToSelf: z.boolean().optional().describe("Assign to the authenticated user"),
    tags: z.array(z.string()).optional(),
    fields: z
      .record(z.string(), z.any())
      .optional()
      .describe("Additional fields by reference name (e.g. the tester identity field)"),
  },
  async ({ type, title, descriptionMarkdown, acceptanceCriteria, testScenarios, assignToSelf, tags, fields: extraFields }) => {
    const blocked = notReady();
    if (blocked) return blocked;
    // seen live: AC pasted into the Description — refuse so it lands in the right field
    // (explicit rules mapping, else auto-discovered from the type's own field list)
    const acField = await resolveSectionField(ado, rules, type, "acceptanceCriteria");
    const tsField = await resolveSectionField(ado, rules, type, "testScenarios");
    if (descriptionMarkdown && /acceptance criteria\s*[:*]/i.test(descriptionMarkdown) && !acceptanceCriteria?.length)
      return json({ error: "descriptionMarkdown contains an 'Acceptance Criteria' section — pass the bullets in the acceptanceCriteria arg instead (the server puts them in the org's dedicated field)" });
    if (descriptionMarkdown && /test scenarios\s*[:*]/i.test(descriptionMarkdown) && !testScenarios?.length)
      return json({ error: "descriptionMarkdown contains a 'Test scenarios' section — pass the bullets in the testScenarios arg instead" });
    const extra: Record<string, any> = { ...(extraFields ?? {}) };
    if (acceptanceCriteria?.length) {
      if (acField) extra[acField] = bulletList(acceptanceCriteria);
      else descriptionMarkdown = `${descriptionMarkdown ?? ""}\n\n**Acceptance Criteria**\n${bulletList(acceptanceCriteria)}`.trim();
    }
    if (testScenarios?.length) {
      if (tsField) extra[tsField] = bulletList(testScenarios);
      else descriptionMarkdown = `${descriptionMarkdown ?? ""}\n\n**Test scenarios**\n${bulletList(testScenarios)}`.trim();
    }
    if (assignToSelf) {
      const email = (await ado.whoAmI()).email;
      // some identity providers omit the account property — "?" would hit ADO as a literal assignee
      if (!email || email === "?") return json({ error: "could not resolve your identity for assignToSelf — create without it or pass System.AssignedTo in fields" });
      extra["System.AssignedTo"] = email;
    }
    if (tags?.length) extra["System.Tags"] = tags.join("; ");
    const wi = await ado.createWorkItem(type, title, descriptionMarkdown, extra, rules.fields.markdownFields ?? []);
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
