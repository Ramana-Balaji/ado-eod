# ado-eod

**End your day with one sentence, not twenty minutes of copy-paste.**

`ado-eod` updates your Azure DevOps tickets from inside your AI coding IDE. It reads what
you actually did today — from your IDE's own session history and your git repos — drafts
the ticket comment, hours, and state change, shows you the draft, and posts it after you
say yes. It also answers the manager side: *"how did the project go this week?"*, *"what
has everyone been working on?"* — straight from Azure DevOps.

Works with **Claude Code**, **OpenAI Codex**, **Cursor**, and **Antigravity**.

## Why

At the end of the day, the only accurate record of your work is inside your AI IDE's
chat history. Re-typing it into Azure DevOps — task name, comment, estimation, issues
faced, test scenarios — is boring enough that everyone delays it. This tool removes the
re-typing. You review a draft and say "yes". That's the whole workflow.

## Setup (once, ~2 minutes)

You need [Node.js 20+](https://nodejs.org). Then:

```bash
npx github:Ramana-Balaji/ado-eod setup
```

It asks one question — **paste your Azure DevOps address** (the page where your tickets
are, e.g. `https://dev.azure.com/contoso/Contoso%20Web`) — and figures out the rest.
If you already know your organization name you can skip the question:

```bash
npx github:Ramana-Balaji/ado-eod setup --org contoso --project "Contoso Web"
```

That one command:
1. finds which supported IDEs you have installed and wires each of them up,
2. opens your browser once to sign in with your normal work account (Microsoft Entra —
   no tokens to create or paste),
3. confirms everything works and tells you what to try.

Restart your IDE afterwards. Done.

Setup installs two things per IDE: the **MCP server** (the six tools) and the **skill** —
the workflow your assistant follows (collect evidence → draft → show you → wait for yes →
post). Claude Code, Cursor and Codex get a `SKILL.md`; Antigravity gets a rules block. The
server also carries the same instructions internally, so any other MCP client you point at
it behaves correctly too.

> No Azure CLI needed. Sign-in is remembered in your OS's secure store (macOS Keychain /
> Windows credential store / Linux libsecret), so you won't be asked again for months.
> If your machine can't use the secure store, set `ADO_EOD_PAT` to a
> [personal access token](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)
> as a fallback.

## Daily use

Type into your IDE's chat:

> update my ticket for today

The assistant collects your day's evidence, drafts each ticket's update, and shows you
exactly what will be written:

- a Markdown comment (what you did, repos touched, issues hit, test scenarios, what's next)
- hours: `Completed 4.5h → 7.0h · 43% → 67% done` — cumulative, never overwritten
- a state change when appropriate

Nothing is posted until you say yes. If the evidence can't fill a required section, it
asks you instead of inventing.

When your work is **complete**, say who tested it:

> this is done, tested with alex — update the ticket

The comment then ends with a sign-off handoff that @-mentions the tester:

> **Status:** complete — tested with @Alex.
> @Alex could you confirm this works as expected and the ticket can be closed?

The tool refuses to set a ticket to Closed or Removed — enforced in the server, not just
the prompt. The tester confirms and closes — that's the point.

## For leads and admins

Ask in plain language:

> how did Fabrikam Web go this week?
> what has Jordan been working on?

Four read-only views: **progress** (state movement, hours), **people** (who's doing what,
last activity), **breakdown** (epic → feature → story tree), **timeline** (dated sequence
of changes and comments). You see exactly what Azure DevOps already lets you see — the
tool uses *your* sign-in, so its permissions are your permissions.

## Rules (for the admin)

Behaviour is governed by a layered rules file — `rules.default.yaml` (shipped) →
org file → `~/.ado-eod/rules.yaml` (per machine), later files win per key:

| Rule | What it controls |
|---|---|
| `ado.*` | organization, default project, and the regex that finds ticket ids in branches/commits |
| `repoRoots` | where to look for git repositories when attributing work |
| `applies.*` | which projects, work item types, and states may be updated; `onlyMyTickets` refuses drafts for tickets assigned to someone else |
| `comment.required` | sections the draft must fill — missing ones are flagged and the assistant asks instead of posting hollow entries |
| `comment.template` / `comment.signoffTemplate` | the comment format and the completion handoff |
| `completion.*` | the maximum state the tool may propose; whether a tester is required |
| `testScenarioField` | which work item field test scenarios are appended to, per type |
| `hours.*` | daily cap (default 14h), idle-gap threshold, rounding |
| `fields.*` | which fields may be written at all (hours, state, long-text) |
| `redact.extraPatterns` | additional redaction patterns (base patterns can never be removed) |

Two things are hard-coded and no rules file can disable them: **confirm-before-post**,
and the **base redaction patterns** (passwords, tokens, connection strings and the like
never leave your machine).

## What it reads, what it writes

**Reads (local):** your own IDE session logs (`~/.claude`, `~/.codex`, `~/.cursor`) and
`git log` of your repos. File *contents* are never included — only paths. All mined text
(your prompts, commit subjects) is scrubbed against redaction patterns before it can
appear in a draft — and you review every draft before anything is posted.

**Writes (Azure DevOps, only after you confirm):** one comment per ticket per day
(re-runs replace it — no double-posting, no double-counted hours), the two hour fields,
optionally a state change and appends (never overwrites) to Description / Repro Steps /
Acceptance Criteria.

## The tools (MCP)

| Tool | Access | Purpose |
|---|---|---|
| `eod_worklog` | local only | the day's evidence bundle |
| `eod_draft` | reads ADO | per-ticket draft: comment, hours, %, state |
| `eod_status` | reads ADO | diagnostics — auth, config, rules in force |
| `eod_report` | reads ADO | progress / people / breakdown / timeline |
| `eod_post` | **writes ADO** | posts a confirmed draft; refuses without `confirmed: true` |
| `eod_create` | **writes ADO** | creates a work item; refuses without `confirmed: true` |

## Development

```bash
git clone https://github.com/Ramana-Balaji/ado-eod
cd ado-eod
npm install
npm test
```

No frameworks: TypeScript, `node:test`, and five small dependencies
(`@modelcontextprotocol/sdk`, `@azure/identity`, `@azure/identity-cache-persistence`,
`yaml`, `zod`).

## License

MIT
