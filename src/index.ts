import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRules, writeUserRules, rememberComment, recallComment } from "./rules.js";
import { parseAdoInput, parseWorkItemUrl } from "./setup.js";
import { collectDay, localToday, dayRange } from "./worklog.js";
import { AdoClient } from "./ado.js";
import { buildDrafts, bulletList, proseLines, missingRequiredFields, resolveSectionField, SCENARIO_HEADING_RE, LEGACY_FOOTER_RE, findEodComment } from "./draft.js";
import { report, ReportView } from "./report.js";
import { checkForUpdate, installLatest, markInstalled, currentVersion, managedCli, APP_DIR, UpdateStatus } from "./update.js";

// let, not const — eod_configure reloads these in place so a fresh install
// works in the same chat session without an IDE restart
let { rules, sources, configErrors } = loadRules();
let ado = new AdoClient(rules);

/** Save org/project and reload in place — used by eod_configure and by pasted ticket links. */
function applyConfig(org: string, project?: string): string {
  const path = writeUserRules(org, project ?? rules.ado.project ?? undefined);
  ({ rules, sources, configErrors } = loadRules());
  ado = new AdoClient(rules);
  return path;
}

// Checked once at startup and refreshed lazily; surfaced on every tool result so a
// stale install can't go unnoticed for weeks (it repeatedly has).
let updateState: UpdateStatus = { current: currentVersion(), updateAvailable: false };
let updateInstalled = false;

async function refreshUpdateState(): Promise<void> {
  try {
    updateState = await checkForUpdate(rules.update?.checkIntervalHours ?? 6);
    // already on disk from a previous run: nothing to fetch, just awaiting a restart
    if (updateState.alreadyInstalled) updateInstalled = true;
    else if (updateState.updateAvailable && rules.update?.auto !== false && !updateInstalled) {
      // install into a directory we own; the running process keeps its loaded code,
      // so this lands for the next launch — never mid-session
      const r = await installLatest();
      updateInstalled = r.ok;
      // record it even on failure-to-match so a tag/package.json mismatch cannot
      // turn every IDE restart into a fresh reinstall
      if (r.ok) markInstalled(updateState.latest);
    }
  } catch {
    /* an update check must never break the tool it is checking */
  }
}

/** Appended to every tool result — silent when there is nothing to say. */
function updateNotice(): Record<string, unknown> {
  if (!updateState.updateAvailable) return {};
  return {
    updateAvailable: {
      running: updateState.current,
      latest: updateState.latest,
      status: updateInstalled
        ? `v${updateState.latest} has been installed to ${APP_DIR.replace(homedir(), "~")} — RESTART the IDE to run it (the current process keeps the old code)`
        : "not installed automatically — run eod_update, or: npx github:Ramana-Balaji/ado-eod setup",
      tellUser: true,
    },
  };
}

/** Local idempotency key — org-scoped so two orgs with the same ticket id never collide. */
const postedKey = (ticketId: number, date: string) => `${rules.ado.org}/${ticketId}/${date}`;

/** ADO-touching tools refuse with a pointer to setup instead of a stack trace. */
function notReady() {
  if (!configErrors.length) return null;
  return json({ error: "ado-eod is not configured", fix: configErrors });
}

// "today" is the user's LOCAL day — toISOString() would lose evenings east of UTC
const today = localToday;

function json(data: unknown) {
  const payload = data && typeof data === "object" && !Array.isArray(data) ? { ...(data as object), ...updateNotice() } : data;
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

// The workflow contract travels WITH the server — every MCP client gets it at initialize,
// even ones setup never wrote a skill file for. The per-IDE SKILL.md is the richer layer.
const INSTRUCTIONS = `End-of-day Azure DevOps ticket updates. Trigger phrases: "update my ticket", "log my day", or a pasted dev.azure.com work item link.

First run needs NO setup: pass any work item link the user pasted to eod_draft's ticketUrls — it carries the org and project and configures the tool automatically. Only if the user names no link and nothing is configured, ask for their Azure DevOps address and call eod_configure. Sign-in opens in the browser on the first Azure DevOps call.

Daily flow — follow this order:
1. eod_worklog for the day's evidence.
2. eod_draft (pass pasted links in ticketUrls and/or bare ids in tickets; write "notes" YOURSELF — short bullet lines of fact from the worklog evidence and the live conversation, do NOT ask the user what they did; "completion" ONLY if the user said the work is complete, with "tester" if they named who tested; how it was verified goes in "testScenarios" — the server routes it to the org's field, never put it in notes).
3. Show the full draft in chat IMMEDIATELY — no questions first: comment markdown, "Completed Xh → Yh · N% → M% done", proposed state, field changes, plus unattributed sessions. Sections in autoFilled were generated from evidence — the user edits if needed.
4. Ask ONLY for what is in missingSections (rare: tester on completion, or zero evidence). Everything else ships as drafted.
5. Only after an explicit yes: eod_post with confirmed=true and the exact values shown (with any edits the user made), copying each draft's date field. Never post unreviewed.

Ticket creation (eod_create): only on explicit request, after showing type+title+description and getting a yes. To nest items pass parentId (or parentUrl) — the child is created in the parent's project and linked as its child; assignToSelf:true assigns it to the signed-in user. The target project is resolved BEFORE fields, and the org's acceptance-criteria / test-scenario fields are discovered from that project's type definition, so no per-org config is needed. A create that would fail a required-field rule is refused first with the full list of missing fields — pass them via the fields arg and retry; do NOT retry blindly. Acceptance criteria go in the acceptanceCriteria arg and test scenarios in the testScenarios arg — NEVER inside descriptionMarkdown or a comment; the server routes them to the org's dedicated fields and rejects descriptions that embed them.

Admin questions ("how did <project> go this week", "what has <person> been working on") → eod_report with view progress|people|breakdown|timeline.

Comment shape, all server-enforced: (a) "headline" is ONE plain-English sentence for non-technical readers (PM, scrum master) — no file names or identifiers; it renders as the "Summary:" line above the detail. (b) "notes" are short bullet lines, one fact each — a prose paragraph is REJECTED. (c) no eod:<date> footer and no date in the body — the header carries the date, and a footer is REJECTED. (d) over the line cap (default 25) is REJECTED. Detail belongs in fields, not the comment. All long-text content (description, acceptance criteria, test scenarios, comment) is written as real Markdown; plain fields like the title stay plain.

Projects are per-ticket: each draft carries its own project, so tickets from different projects work in one run with no reconfiguration.

A 403 on create names the project and area path it targeted — a wrong-project target returns the same code as a real permission gap, so check the reported project before telling the user they lack access.

If a tool result carries updateAvailable, TELL THE USER in one line: a newer ado-eod is installed and takes effect after they restart the IDE. Do not suppress it. eod_update installs on demand.

Server-enforced (don't fight): hours cumulative with a daily cap; comment line cap; Closed/Removed never set — the tester closes; same-day re-runs update the existing comment idempotently. Any tool failure → run eod_status and relay its fix.`;

export const server = new McpServer({ name: "ado-eod", version: "0.8.0" }, { instructions: INSTRUCTIONS });

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
    ticketUrls: z.array(z.string()).optional().describe("Work item LINKS the user pasted — preferred over ticket ids: they carry the org/project, so a first-time user needs no setup"),
    notes: z.string().optional().describe("Summary of the day's work from the live conversation"),
    headline: z.string().optional().describe("ONE plain-English sentence for non-technical readers (project manager, scrum master): what moved and what it means. No file names, code identifiers, branch names or jargon — those go in notes. Generated from evidence if omitted."),
    completion: z
      .object({ ticketId: z.number(), tester: z.string().optional() })
      .optional()
      .describe("Set ONLY when the user says the work is complete; tester = who verified it"),
    testScenarios: z
      .array(z.string())
      .optional()
      .describe("How the work was verified, as short bullets — the server routes these to the org's test-scenario FIELD; never paste them into notes or the comment"),
  },
  async ({ date, tickets, ticketUrls, notes, headline, completion, testScenarios }) => {
    // a pasted link carries org (+project) — adopt it so first use needs no setup
    const fromUrls = (ticketUrls ?? []).map(parseWorkItemUrl);
    const withOrg = fromUrls.find((u) => u.org);
    if (withOrg?.org && withOrg.org !== rules.ado.org) applyConfig(withOrg.org, withOrg.project);
    const blocked = notReady();
    if (blocked) return blocked;
    const ids = [...new Set([...(tickets ?? []), ...fromUrls.map((u) => u.id).filter((n): n is number => !!n)])];
    const day = date ?? today();
    const evidence = await collectDay(day, rules);
    const range = dayRange(day);
    const knownCommentIds: Record<number, number> = {};
    for (const id of ids) {
      const known = recallComment(postedKey(id, day));
      if (known !== undefined) knownCommentIds[id] = known;
    }
    const authorDisplayName = await ado.whoAmI().then((m) => m.displayName).catch(() => undefined);
    const result = await buildDrafts(ado, rules, {
      evidence, tickets: ids.length ? ids : undefined, notes, headline, completion, testScenarios,
      knownCommentIds, authorDisplayName, dayStartMs: range.startMs, dayEndMs: range.endMs,
    });
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
    const path = applyConfig(parsed.org, project ?? parsed.project);
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
  "eod_update",
  "Install the latest ado-eod release. Safe to call any time; it only replaces this tool's own files. The running server keeps its loaded code, so the new version takes effect after an IDE restart.",
  {},
  async () => {
    const before = await checkForUpdate(0); // force a fresh check
    if (!before.updateAvailable) return json({ ok: true, upToDate: true, running: before.current, latest: before.latest });
    const r = await installLatest();
    updateInstalled = r.ok;
    if (r.ok) markInstalled(before.latest);
    updateState = before;
    return json({
      ok: r.ok,
      running: before.current,
      latest: before.latest,
      installedTo: r.ok ? managedCli().replace(homedir(), "~") : undefined,
      nextStep: r.ok
        ? "Restart the IDE — the new version loads then. If your MCP config still points at npx, run: npx github:Ramana-Balaji/ado-eod setup"
        : "Automatic install failed; run manually: rm -rf ~/.npm/_npx && npx github:Ramana-Balaji/ado-eod setup",
      detail: r.output || undefined,
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
      version: updateState.current,
      latestRelease: updateState.latest ?? "(not checked)",
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
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("The day this update covers — copy the draft's date. Drives same-day idempotency; defaults to today"),
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

        const markerDate = u.date ?? today();

        // concurrent-edit guard BEFORE we write anything: posting our own comment bumps
        // rev, so testing the draft-time rev inside the field PATCH would always fail
        const wi = await ado.getWorkItem(u.ticketId);
        if (wi.rev !== u.rev) {
          results.push({ ticketId: u.ticketId, ok: false, error: `ticket changed since draft (rev ${u.rev} → ${wi.rev}) — redraft with eod_draft and confirm again` });
          continue;
        }

        // the date belongs in the header only — no eod:<date> footer, ever
        if (LEGACY_FOOTER_RE.test(u.commentMarkdown)) {
          results.push({ ticketId: u.ticketId, ok: false, error: "remove the `eod:<date>` footer from commentMarkdown — the date is in the header and this tool no longer uses a marker line" });
          continue;
        }

        // bullets only — a paragraph comment is unscannable and was reported twice
        const prose = proseLines(u.commentMarkdown);
        if (prose.length) {
          results.push({ ticketId: u.ticketId, ok: false, error: `comment must be bullet points, not paragraphs. Rewrite these lines as "- " bullets: ${prose.map((l) => l.slice(0, 60)).join(" | ")}` });
          continue;
        }

        // comments are a daily log line, not a report — reject essays
        const maxLines = rules.comment.maxLines ?? 25;
        if (u.commentMarkdown.split("\n").length > maxLines) {
          results.push({ ticketId: u.ticketId, ok: false, error: `comment is ${u.commentMarkdown.split("\n").length} lines — max ${maxLines}. Tighten the summary; details belong in fields, not the comment` });
          continue;
        }

        const wiType = wi.fields["System.WorkItemType"];
        // the ticket's OWN project — a user works across several, one global default is wrong
        const wiProject = wi.fields["System.TeamProject"];
        const scenarioF = await resolveSectionField(ado, rules, wiType, "testScenarios", wiProject);
        const acF = await resolveSectionField(ado, rules, wiType, "acceptanceCriteria", wiProject);

        // hard rule, seen violated live twice: a comment must not carry a test-scenarios
        // section when the type has a real field for it — that's what eod_draft's
        // testScenarios arg is for
        if (SCENARIO_HEADING_RE.test(u.commentMarkdown) && scenarioF && !(u.fieldAppends ?? []).some((fa) => fa.field === scenarioF)) {
          results.push({ ticketId: u.ticketId, ok: false, error: `this comment embeds a Test scenarios section, but this work item type stores them in the "${scenarioF}" field — redraft with eod_draft's testScenarios arg (the server routes them) and confirm again` });
          continue;
        }

        // idempotency without a visible marker: the comment id we recorded locally, else
        // a same-day comment of ours still on the ticket
        const range = dayRange(markerDate);
        const comments = await ado.getComments(u.ticketId, wiProject);
        const dup = findEodComment(comments, markerDate, {
          knownId: recallComment(postedKey(u.ticketId, markerDate)),
          author: await ado.whoAmI().then((m) => m.displayName).catch(() => undefined),
          dayStartMs: range.startMs,
          dayEndMs: range.endMs,
        });
        const skipHours = Boolean(dup);

        if (dup) {
          await ado.updateComment(u.ticketId, dup.id, u.commentMarkdown, rules.comment.format, wiProject);
          rememberComment(postedKey(u.ticketId, markerDate), dup.id);
        } else {
          const posted = await ado.addComment(u.ticketId, u.commentMarkdown, rules.comment.format, wiProject);
          if (posted?.id) rememberComment(postedKey(u.ticketId, markerDate), posted.id);
        }

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
          // every long-text section field is written as real Markdown — including
          // auto-discovered org fields the static markdownFields list can't know about
          if (rules.fields.markdownFields?.includes(k) || k === scenarioF || k === acF) markdownFields.push(k);
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
    parentId: z.number().optional().describe("Link the new item as a CHILD of this work item id (Feature → User Story → Task). ADO rejects combinations its process template disallows."),
    parentUrl: z.string().optional().describe("Parent work item LINK, if the user pasted one instead of an id"),
    project: z.string().optional().describe("Target project. Ignored when a parent is given (the child follows its parent); otherwise overrides the configured default"),
    assignToSelf: z.boolean().optional().describe("Assign to the authenticated user"),
    tags: z.array(z.string()).optional(),
    fields: z
      .record(z.string(), z.any())
      .optional()
      .describe("Additional fields by reference name (e.g. the tester identity field)"),
  },
  async ({ type, title, descriptionMarkdown, acceptanceCriteria, testScenarios, parentId, parentUrl, project: projectArg, assignToSelf, tags, fields: extraFields }) => {
    const blocked = notReady();
    if (blocked) return blocked;

    // ---- 1. Resolve the TARGET PROJECT first. Everything below is project-specific:
    // field discovery against the wrong project finds nothing and silently drops data.
    const parsedParent = parentUrl ? parseWorkItemUrl(parentUrl) : undefined;
    const parent = parentId ?? parsedParent?.id;
    if (parentUrl && parent === undefined)
      return json({ error: `could not read a work item id from parentUrl "${parentUrl}" — expected .../_workitems/edit/<id>. Pass parentId instead; refusing rather than creating in the default project` });
    // work item ids are per-ORG: looking this id up in the configured org would silently
    // resolve a different item and parent the new one to it
    if (parsedParent?.org && parsedParent.org !== rules.ado.org)
      return json({
        error: `parentUrl is in organization "${parsedParent.org}" but ado-eod is configured for "${rules.ado.org}". Work item ids are per-organization, so id ${parent} means something else here — refusing.`,
        fix: `Run eod_configure with ${parsedParent.org} (or paste a ticket from it into eod_draft) before creating there.`,
      });
    let project: string | undefined;
    if (parent !== undefined) {
      // a child lives in its parent's project — cross-project hierarchy links are invalid
      project = await ado.getProjectOf(parent).catch(() => undefined);
      if (!project) return json({ error: `parent work item ${parent} not found or not readable — check the id/link` });
    }
    project = project ?? projectArg ?? rules.ado.project;
    if (!project) return json({ error: "no target project — pass project, or parentId/parentUrl, or configure one with eod_configure" });

    // ---- 2. Route the section args using THIS project's type definition
    const acField = await resolveSectionField(ado, rules, type, "acceptanceCriteria", project);
    const tsField = await resolveSectionField(ado, rules, type, "testScenarios", project);
    if (descriptionMarkdown && /acceptance criteria\s*[:*]/i.test(descriptionMarkdown) && !acceptanceCriteria?.length)
      return json({ error: "descriptionMarkdown contains an 'Acceptance Criteria' section — pass the bullets in the acceptanceCriteria arg instead (the server puts them in the org's dedicated field)" });
    if (descriptionMarkdown && /test scenarios\s*[:*]/i.test(descriptionMarkdown) && !testScenarios?.length)
      return json({ error: "descriptionMarkdown contains a 'Test scenarios' section — pass the bullets in the testScenarios arg instead" });

    const extra: Record<string, any> = { ...(extraFields ?? {}) };
    // Never quietly relocate supplied content into the Description — if the type has no
    // such field, say so and name the rules.yaml key that would fix it.
    for (const [kind, values, field] of [
      ["acceptanceCriteria", acceptanceCriteria, acField],
      ["testScenarios", testScenarios, tsField],
    ] as const) {
      if (!values?.length) continue;
      if (!field)
        return json({
          error: `"${type}" in project "${project}" has no ${kind} field, and ${kind} was supplied. Add the mapping and retry.`,
          fix: `${kind === "testScenarios" ? "testScenarioField" : "acceptanceCriteriaField"}:\n  ${type}: <Field.ReferenceName>`,
          rulesFile: "~/.ado-eod/rules.yaml",
          availableFields: (await ado.getTypeFields(type, project).catch(() => [])).map((f) => `${f.name} (${f.referenceName})`),
        });
      extra[field] = bulletList(values);
    }

    if (assignToSelf) {
      const email = (await ado.whoAmI()).email;
      // some identity providers omit the account property — "?" would hit ADO as a literal assignee
      if (!email || email === "?") return json({ error: "could not resolve your identity for assignToSelf — create without it or pass System.AssignedTo in fields" });
      extra["System.AssignedTo"] = email;
    }
    if (tags?.length) extra["System.Tags"] = tags.join("; ");
    // discovered section fields get the Markdown format op too, not just the static list
    const mdFields = [...new Set([...(rules.fields.markdownFields ?? []), acField, tsField].filter(Boolean) as string[])];

    // ---- 3. Pre-flight the process template's required fields, so a create fails here
    // with the full list rather than one truncated TF401320 at a time
    const typeFields = await ado.getTypeFields(type, project).catch(() => []);
    const supplied = { ...extra, "System.Description": descriptionMarkdown ?? "" };
    const missing = missingRequiredFields(typeFields, supplied);
    if (missing.length)
      return json({
        error: `"${type}" in project "${project}" requires ${missing.length} field(s) that were not supplied: ${missing.map((m) => `${m.name} (${m.field})`).join(", ")}`,
        fix: "Pass each in the fields arg, e.g. fields: { \"" + missing[0].field + '": "..." }. If one is acceptance criteria or test scenarios, use those args and map the field in ~/.ado-eod/rules.yaml.',
        missingFields: missing,
      });

    let wi;
    try {
      wi = await ado.createWorkItem(type, title, descriptionMarkdown, extra, mdFields, project, parent);
    } catch (e: any) {
      // a 403 here is ambiguous: no permission, OR the right permission on the wrong
      // project/area. Always say what was targeted so the caller can tell them apart.
      if (e?.status === 403)
        return json({
          error: `Azure DevOps refused the create (403) targeting project "${project}"${parent ? ` under parent ${parent}` : ""}.`,
          targetedProject: project,
          targetedAreaPath: extra["System.AreaPath"] ?? `(default root area of ${project})`,
          note: "The same 403/TF401289 is returned for a wrong-project or wrong-area target as for a genuine permission gap — verify the project above is the intended one before concluding the user lacks access.",
          detail: e.message?.slice(0, 800),
        });
      return json({ error: e.message?.slice(0, 1200), targetedProject: project, ruleErrors: e?.ruleErrors ?? [] });
    }
    return json({
      id: wi.id,
      rev: wi.rev,
      parent: parent ?? null,
      project,
      url: `https://dev.azure.com/${rules.ado.org}/${encodeURIComponent(project)}/_workitems/edit/${wi.id}`,
    });
  },
);

export async function main() {
  await server.connect(new StdioServerTransport());
  // fire-and-forget: startup must not wait on the network
  void refreshUpdateState();
}
