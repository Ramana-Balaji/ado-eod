---
name: ado-eod
description: End-of-day Azure DevOps ticket update — collects today's work from IDE histories + git, drafts the ticket comment/hours/state, posts after the user confirms. Use when the user says /ado-eod, "update my ticket", "log my day", "fill my ADO ticket", or pastes a dev.azure.com work item link. Also handles admin rollups ("how did project X go this week", "what has <person> been working on") via eod_report.
---

# ado-eod — end-of-day ticket update

MCP server `ado-eod` provides all tools. If any tool call fails, run `eod_status` first
and relay its message — it names the fix (sign-in, rules file, missing history).

## First run (not configured yet)

**Usually nothing to do** — pass any work item link the user pasted to `eod_draft`'s
`ticketUrls`. The link carries org and project, so the tool configures itself.

Only when the user gives no link and nothing is configured: ask for their Azure DevOps
address and call `eod_configure`. Never guess the org. Sign-in opens in their browser on
the first Azure DevOps call — tell them to watch for the window.

Tickets from **different projects** work in one run: each draft carries its own
project, resolved from the work item itself.

## Daily flow (developer)

1. `eod_worklog` — today's evidence (or `date` if the user names another day). Read it.
2. `eod_draft` with:
   - `ticketUrls`: full links the user pasted (preferred — they carry org/project)
   - `tickets`: bare work item ids the user typed
   - `notes`: 2–4 sentence summary of what was actually done — **write it yourself**
     from the worklog evidence (prompts, files, commits) and the live conversation.
     Factual, no fluff. Do NOT ask the user what they did; the evidence answers that.
   - `completion`: ONLY if the user said the work is complete. Include `tester` if they
     named who tested it ("tested with alex"). Never infer completion.
   - `testScenarios`: how the work was verified, as short bullets. The server routes
     them to the org's test-scenario **field** — never write them into `notes` or the
     comment text.
3. **Show the draft in chat immediately — no questions first** — per ticket: the comment
   markdown, `Completed Xh → Yh · N% → M% done`, proposed state, field appends and
   set-fields. List unattributed sessions and git-only repos too. Sections listed in
   `autoFilled` were generated from evidence; say so, the user edits if needed.
4. Ask ONLY for what `missingSections` lists — rare: the tester on completion, or a
   ticket with zero evidence today. Everything else ships as drafted.
5. Wait for an explicit yes (with any edits applied). Then `eod_post` with
   `confirmed: true` and the exact values the user saw. Report the per-ticket results.

Rules (enforced by the server, don't fight them): hours are cumulative and capped per
day; the tool never proposes Closed — the tester closes after confirming; a same-day
re-run replaces the comment and skips hour fields (idempotent); comments over the line
cap (default 25) are rejected — keep `notes` to 2–4 sentences, details go in fields.
All long-text content is posted as real Markdown; plain fields (title) stay plain.

## Creating a ticket

Only when the user explicitly asks to create one. Show type + title + description in
chat, wait for yes, then `eod_create` with `confirmed: true`. Never create as a side
effect of the daily flow.

**Use the dedicated args, not the Description.** Pass `acceptanceCriteria` and
`testScenarios` as bullet arrays — the server routes them to the org's mapped fields
and **rejects** a `descriptionMarkdown` that embeds an "Acceptance Criteria" or "Test
scenarios" section. Description keeps only the narrative and links. The tester goes in
the tester identity field via `fields`.

## Admin flow

"how did <project> go this week" / "what has <person> been working on" →
`eod_report` with view `progress` | `people` | `breakdown` | `timeline`.
Render the JSON as a readable summary; quote `eodHighlights` when present.
