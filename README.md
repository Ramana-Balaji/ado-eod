# ado-eod

Update your Azure DevOps tickets from your AI IDE. It reads what you actually did today
(IDE session history + git), drafts the comment, hours, and state, and posts after you
say yes. Works with **Claude Code**, **Codex**, **Cursor**, and **Antigravity**.

## Setup

Needs [Node.js 20+](https://nodejs.org). One command, any terminal (VS Code's is fine):

```bash
npx github:Ramana-Balaji/ado-eod setup
```

Paste your Azure DevOps address when asked (`https://dev.azure.com/<org>/<project>`),
sign in once in the browser, restart your IDE. Done. First run builds for a minute or
two before printing — that's normal.

Works for the Claude desktop app, VS Code extension, and CLI alike — no `claude`
command needed.

<details>
<summary>Plugin installs (optional)</summary>

**Claude Code CLI:**

```bash
claude plugin marketplace add Ramana-Balaji/ado-eod
claude plugin install ado-eod@ado-eod
```

**Cursor 2.5+:** `/add-plugin` → paste `https://github.com/Ramana-Balaji/ado-eod`.

No npx needed after either: on first use the assistant asks for your Azure DevOps
address and configures itself in chat. Sign-in opens in the browser on the first call.
If you also run `setup`, it detects the Claude Code plugin and leaves it alone (Cursor:
remove the duplicate from `~/.cursor/mcp.json`).

</details>

> Sign-in is remembered in your OS keychain. No Azure CLI, no tokens. Fallback:
> set `ADO_EOD_PAT` to a [personal access token](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate).

## Use

Say it in chat:

| Prompt | Writes? |
|---|---|
| `is ado-eod working?` | no — diagnostics |
| `what did I work on today?` | no — day's evidence |
| `update my ticket for today` | after your yes |
| `update ticket 12345 with today's work` | after your yes |
| `this is done, tested with Alex — update the ticket` | after your yes |
| `create a ticket for the caching bug we found` | after your yes |
| `how did Fabrikam Web go this week?` | no — admin report |

The draft is pre-filled from your evidence (commits, sessions, ticket title) and shown
in full — you edit if needed, then say yes. Nothing posts unreviewed. The only question
it ever asks: who tested, when you say work is complete.

Guaranteed by the server, not the prompt: hours are cumulative with a daily cap;
same-day re-runs update the existing comment (no duplicates, no double counting);
Closed/Removed are never set — your tester closes; acceptance criteria and test
scenarios go to your org's dedicated fields, never dumped into the description or
comment.

## Rules (admin)

Layered config: `rules.default.yaml` (shipped) → org file → `~/.ado-eod/rules.yaml`.
Later wins per key. `eod_status` shows what's in force. Highlights:

```yaml
applies: { onlyMyTickets: true }          # refuse tickets assigned to others
hours: { maxPerDay: 14, roundToHours: 0.5 }
testScenarioField:                        # per-type field routing
  User Story: Microsoft.VSTS.Common.AcceptanceCriteria
  Bug: Microsoft.VSTS.TCM.ReproSteps
acceptanceCriteriaField:
  User Story: Microsoft.VSTS.Common.AcceptanceCriteria
testerField: Custom.Tester                # identity field for sign-off
redact: { extraPatterns: [] }             # additive; base patterns can't be removed
```

Hard-coded, not overridable: confirm-before-post, base redaction patterns (secrets
never leave your machine). Local reads only: session logs and `git log` — file paths,
never file contents; everything mined is redacted before it can reach a draft.

## Tools

| Tool | Access |
|---|---|
| `eod_worklog` | local only — day's evidence |
| `eod_draft` | reads ADO — the draft |
| `eod_configure` | local — first-run org setup from chat |
| `eod_status` | reads ADO — diagnostics |
| `eod_report` | reads ADO — progress / people / breakdown / timeline |
| `eod_post` | **writes** — confirmed drafts only |
| `eod_create` | **writes** — confirmed creations only |

## Development

```bash
git clone https://github.com/Ramana-Balaji/ado-eod && cd ado-eod && npm install && npm test
```

TypeScript, `node:test`, five dependencies. MIT license.
