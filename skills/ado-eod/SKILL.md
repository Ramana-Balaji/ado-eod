---
name: ado-eod
description: End-of-day Azure DevOps ticket update — collects today's work from IDE histories + git, drafts the ticket comment/hours/state, posts after the user confirms. Use when the user says /ado-eod, "update my ticket", "log my day", "fill my ADO ticket", or pastes a dev.azure.com work item link. Also handles admin rollups ("how did project X go this week", "what has <person> been working on") via eod_report.
---

# ado-eod — end-of-day ticket update

MCP server `ado-eod` provides all tools. If any tool call fails, run `eod_status` first
and relay its message — it names the fix (sign-in, rules file, missing history).

## Daily flow (developer)

1. `eod_worklog` — today's evidence (or `date` if the user names another day). Read it.
2. `eod_draft` with:
   - `tickets`: any work item ids/links the user mentioned (extract the number)
   - `notes`: 2–4 sentence summary of what was actually done, written from the live
     conversation and the worklog evidence. Factual, no fluff.
   - `completion`: ONLY if the user said the work is complete. Include `tester` if they
     named who tested it ("tested with alex"). Never infer completion.
3. **Show the draft in chat** — per ticket: the comment markdown, `Completed Xh → Yh · N% → M% done`,
   proposed state, field appends and set-fields. List unattributed sessions and git-only repos too.
4. `missingSections` non-empty → ask the user for exactly those items, then redraft.
   Never invent content for a required section.
5. Wait for an explicit yes. Then `eod_post` with `confirmed: true` and the exact values
   the user saw. Report the per-ticket results.

Rules (enforced by the server, don't fight them): hours are cumulative and capped per
day; the tool never proposes Closed — the tester closes after confirming; a same-day
re-run replaces the comment and skips hour fields (idempotent).

## Creating a ticket

Only when the user explicitly asks to create one. Show type + title + description in
chat, wait for yes, then `eod_create` with `confirmed: true`. Never create as a side
effect of the daily flow.

**Use the org's dedicated fields, not one giant Description.** Acceptance criteria go in
the type's acceptance-criteria field, test scenarios in its test-scenarios field, the
tester in the tester identity field — the per-type mappings live in
`~/.ado-eod/rules.yaml` (`acceptanceCriteriaField`, `testScenarioField`, `testerField`).
Pass them via `eod_create`'s `fields` arg or `eod_post`'s `setFields`. Description keeps
only the narrative and links.

## Admin flow

"how did <project> go this week" / "what has <person> been working on" →
`eod_report` with view `progress` | `people` | `breakdown` | `timeline`.
Render the JSON as a readable summary; quote `eodHighlights` when present.
