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

You need [Node.js 20+](https://nodejs.org). Then open any terminal (the one inside
VS Code is fine) and run **one command**:

```bash
npx github:Ramana-Balaji/ado-eod setup
```

> The first run builds the tool and takes a minute or two before printing anything —
> that's normal.

It asks one question — **paste your Azure DevOps address** (the page where your tickets
are; it looks like `https://dev.azure.com/<your-org>/<your-project>`) — and figures out
the rest. If you already know your organization and project names you can skip the
question by passing them yourself:

```bash
npx github:Ramana-Balaji/ado-eod setup --org <your-org> --project "<your project>"
```

That one command:
1. finds which supported IDEs you have installed and wires each of them up
   (Claude Code, Codex, Cursor, Antigravity),
2. opens your browser once to sign in with your normal work account (Microsoft Entra —
   no tokens to create or paste),
3. confirms everything works and tells you what to try.

Restart your IDE afterwards. Done — jump to [First prompts to try](#first-prompts-to-try).

This works for **every** way of running Claude Code — the desktop app, the VS Code
extension, and the terminal CLI all read the same config (`~/.claude.json` and
`~/.claude/skills/`), and setup writes it directly. You do **not** need the `claude`
command in your terminal.

Setup installs two things per IDE: the **MCP server** (the six tools) and the **skill**
that teaches your assistant how to use them — see [The skill](#the-skill).

### Optional: install as a plugin instead (Claude Code CLI users)

If you *do* use the `claude` CLI in a terminal, you can take the server + skill as a
versioned plugin instead of letting setup wire them:

```bash
claude plugin marketplace add Ramana-Balaji/ado-eod
claude plugin install ado-eod@ado-eod
```

Update later with `claude plugin update ado-eod`. **No npx needed after this**: the
first time you say "update my ticket", the assistant notices nothing is configured,
asks you to paste your Azure DevOps address, and saves it itself (`eod_configure`).
Sign-in opens in your browser on the first Azure DevOps call.

You can still run the setup command above (say, to wire up Cursor or Codex too) — it
detects the plugin and leaves Claude Code's own config alone, so the server is never
registered twice.

### Optional: Cursor plugin

This repo is also a Cursor plugin (Cursor 2.5+): in Cursor, run `/add-plugin` and paste
`https://github.com/Ramana-Balaji/ado-eod`. Same as Claude Code: no `setup` needed —
first use configures itself in chat via `eod_configure`. If you *do* run setup (for
other IDEs), note that it does not yet detect a Cursor plugin install and will also
write the server into `~/.cursor/mcp.json` — remove that `ado-eod` entry if you use the
plugin.

> No Azure CLI needed. Sign-in is remembered in your OS's secure store (macOS Keychain /
> Windows credential store / Linux libsecret), so you won't be asked again for months.
> If your machine can't use the secure store, set `ADO_EOD_PAT` to a
> [personal access token](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)
> as a fallback.

## First prompts to try

All of these go straight into your IDE's chat — no commands to learn. Right after setup,
start with the safe ones:

| Try saying | What happens | Writes anything? |
|---|---|---|
| `is ado-eod working?` | runs diagnostics — shows who you're signed in as, your org/project, which IDE histories it can see | no |
| `what did I work on today?` | shows the day's evidence: sessions, prompts, repos, commits | no |
| `update my ticket for today` | drafts the full ticket update and shows it — posts only after you say yes | only after your yes |
| `update ticket 12345 with today's work` | same, for a specific ticket | only after your yes |
| `log my day — spent most of it on the login bug, still not done` | your one-sentence summary becomes part of the draft | only after your yes |
| `this is done, tested with Alex — update the ticket` | draft includes the completion sign-off @-mentioning Alex | only after your yes |
| `create a ticket for the caching bug we just found` | shows type + title + description, creates after you confirm | only after your yes |

Nothing writes to Azure DevOps until you've seen the exact draft and said yes — so feel
free to run `update my ticket for today` just to see what it produces.

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
