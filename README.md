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

You need [Node.js 20+](https://nodejs.org).

### Claude Code — install as a plugin (recommended)

```bash
claude plugin marketplace add Ramana-Balaji/ado-eod
claude plugin install ado-eod@ado-eod
```

That gives Claude Code the MCP server **and** the skill in one versioned unit — update
later with `claude plugin update ado-eod`. Then run the setup once for your org config
(and any other IDEs you use):

```bash
npx github:Ramana-Balaji/ado-eod setup --org contoso --project "Contoso Web"
```

> Use the plugin *or* setup's Claude Code wiring, not both — otherwise the server is
> registered twice.

### Cursor — install as a plugin (recommended)

This repo is also a Cursor plugin (Cursor 2.5+): in Cursor, run `/add-plugin` and paste
`https://github.com/Ramana-Balaji/ado-eod`. That installs the MCP server and the skill
together. Same rule applies: plugin *or* setup's Cursor wiring, not both.

### Other IDEs (Codex, Antigravity) — one command

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

Setup installs two things per IDE: the **MCP server** (the six tools) and the **skill**
that teaches your assistant how to use them — see [The skill](#the-skill).

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

## The skill

Tools alone don't make an assistant behave — the **skill** is the workflow contract that
ships with this package and gets installed by setup, so every machine follows the same
steps:

1. collect the day's evidence, 2. draft, 3. **show you everything**, 4. ask (never invent)
when a required section is empty, 5. post only after your explicit yes — and use your
org's dedicated fields instead of one giant Description.

| IDE | Where the skill lands | How it triggers |
|---|---|---|
| Claude Code | via the plugin (or `~/.claude/skills/ado-eod/SKILL.md` if you used setup) | `/ado-eod`, "update my ticket", "log my day", a pasted work-item link |
| Cursor | via the plugin (or `~/.cursor/skills/ado-eod/SKILL.md` if you used setup) | same phrases |
| Codex | `~/.codex/skills/ado-eod/SKILL.md` | same phrases |
| Antigravity | marker-guarded block in `~/.codeium/memories/global_rules.md` | same phrases |
| any other MCP client | nothing to install — the server announces the same instructions during the MCP handshake | automatic |

The skill is one file in this repo ([`skill/SKILL.md`](skill/SKILL.md)). When it changes,
re-running `npx github:Ramana-Balaji/ado-eod setup` refreshes every IDE — re-runs replace
the installed copy, they never stack duplicates.

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
| `testScenarioField` / `acceptanceCriteriaField` | which dedicated work item field each goes to, per type |
| `testerField` | the identity field the sign-off tester is written to (e.g. `Custom.Tester`) |
| `hours.*` | daily cap (default 14h), idle-gap threshold, rounding |
| `fields.*` | which fields may be written at all; `markdownFields` lists large-text fields written as real Markdown |
| `redact.extraPatterns` | additional redaction patterns (base patterns can never be removed) |

Two things are hard-coded and no rules file can disable them: **confirm-before-post**,
and the **base redaction patterns** (passwords, tokens, connection strings and the like
never leave your machine).

### Mapping your org's custom fields

Many process templates have dedicated fields for acceptance criteria, test scenarios, and
testers — the tool fills those instead of dumping everything into the Description. Tell it
your field names once, in `~/.ado-eod/rules.yaml` (or the org rules file):

```yaml
testScenarioField:
  Enhancement: Custom.TestScenarios     # your org's reference names —
acceptanceCriteriaField:                # find them under Organization settings
  Enhancement: Microsoft.VSTS.Common.AcceptanceCriteria
testerField: Custom.Tester              # identity field; filled on sign-off
fields:
  markdownFields: [System.Description, Microsoft.VSTS.Common.AcceptanceCriteria, Custom.TestScenarios]
```

Any field listed in `markdownFields` is stored as real Markdown (ADO otherwise silently
treats it as HTML). Identity fields resolve from an email address.

## What it reads, what it writes

**Reads (local):** your own IDE session logs (`~/.claude`, `~/.codex`, `~/.cursor`) and
`git log` of your repos. File *contents* are never included — only paths. All mined text
(your prompts, commit subjects) is scrubbed against redaction patterns before it can
appear in a draft — and you review every draft before anything is posted.

**Writes (Azure DevOps, only after you confirm):** one comment per ticket per day
(re-runs update it in place — no double-posting, no double-counted hours), the two hour
fields, optionally a state change, appends (never overwrites) to long-text fields, and
direct sets for identity fields like the tester box. Everything long-form is written as
Markdown.

## The tools (MCP)

| Tool | Access | Purpose |
|---|---|---|
| `eod_worklog` | local only | the day's evidence bundle |
| `eod_draft` | reads ADO | per-ticket draft: comment, hours, %, state |
| `eod_status` | reads ADO | diagnostics — auth, config, rules in force |
| `eod_report` | reads ADO | progress / people / breakdown / timeline |
| `eod_post` | **writes ADO** | posts a confirmed draft (comment, hours, state, field appends/sets); refuses without `confirmed: true` |
| `eod_create` | **writes ADO** | creates a work item, with `fields` for your org's dedicated fields; refuses without `confirmed: true` |


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
