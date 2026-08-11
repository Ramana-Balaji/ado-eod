import { test } from "node:test";
import assert from "node:assert/strict";
import { activeMinutes, classifyWorkType, extractTicketIds, cleanPrompt, roundAndCapHours, dayRange, inRange, localToday, repoHasSession, pathsOverlap } from "../src/worklog.js";
import { attribute, splitHours, findEodComment, buildDrafts, resolveSectionField, toBullets, proseLines, missingRequiredFields, SCENARIO_HEADING_RE, EOD_MARKER_RE, LEGACY_FOOTER_RE } from "../src/draft.js";
import { buildCreateOps, ruleErrors } from "../src/ado.js";
import { BASE_REDACT_PATTERNS } from "../src/rules.js";
import type { Rules } from "../src/rules.js";
import type { DayEvidence, SessionRecord } from "../src/worklog.js";

const rules = {
  ado: { org: "x", project: "p", ticketIdPattern: "[A-Z]{2,5}-(\\d+)" },
  hours: { maxPerDay: 14, idleGapMinutes: 30, roundToHours: 0.5 },
} as Rules;

const t = (h: number, m: number) => `2026-07-31T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

test("activeMinutes excludes idle gaps > threshold", () => {
  // 10:00→10:20 active (20m), 3h gap, 13:20→13:40 active (20m) = 40m, not 220m
  assert.equal(activeMinutes([t(10, 0), t(10, 10), t(10, 20), t(13, 20), t(13, 40)], 30), 40);
});

test("activeMinutes handles unsorted and single timestamps", () => {
  assert.equal(activeMinutes([t(10, 20), t(10, 0)], 30), 20);
  assert.equal(activeMinutes([t(10, 0)], 30), 1);
  assert.equal(activeMinutes([], 30), 0);
});

test("roundAndCapHours rounds to step and caps at maxPerDay (14h, not 8)", () => {
  assert.equal(roundAndCapHours(160, rules), 2.5); // 2.67h → 2.5
  assert.equal(roundAndCapHours(20 * 60, rules), 14); // capped
});

test("classifyWorkType", () => {
  assert.equal(classifyWorkType({ Read: 5, Grep: 2 }, []), "analysis");
  assert.equal(classifyWorkType({ Edit: 3 }, ["/a/README.md", "/a/docs.md"]), "documentation");
  assert.equal(classifyWorkType({ Edit: 3 }, ["/a/foo.test.ts"]), "testing");
  assert.equal(classifyWorkType({ Edit: 3, Write: 1 }, ["/a/src/foo.ts"]), "implementation");
});

test("extractTicketIds pulls numeric ids from branches, prompts, commits", () => {
  const ids = extractTicketIds(
    ["bugfix/predev-AB-17513-fix-thing", "[CD-13833]: oauth integration", "no ticket here"],
    rules.ado.ticketIdPattern,
  );
  assert.deepEqual(ids.sort(), ["13833", "17513"]);
});

test("cleanPrompt strips command noise and bare slash commands", () => {
  assert.equal(cleanPrompt("/model", BASE_REDACT_PATTERNS).text, null);
  const wrapped = "<command-message>my-command</command-message>\n<command-name>/my-command</command-name>";
  assert.equal(cleanPrompt(wrapped, BASE_REDACT_PATTERNS).text, null);
});

test("cleanPrompt redacts planted secrets", () => {
  const input = "fix the login flow\nAPI_KEY=sk-abc123secretvalue\nthen run tests";
  const { text, redacted } = cleanPrompt(input, BASE_REDACT_PATTERNS);
  assert.equal(redacted >= 1, true);
  assert.equal(text?.includes("sk-abc123secretvalue"), false);
  assert.equal(text?.includes("fix the login flow"), true);
  assert.equal(cleanPrompt("mongodb+srv://user:pass@host/db", BASE_REDACT_PATTERNS).text, null);
});

function sess(id: string, tickets: string[], minutes: number): SessionRecord {
  return {
    source: "claude-code", sessionId: id, branches: [], first: "", last: "",
    activeMinutes: minutes, precision: "fine", prompts: ["p"], tools: {},
    files: [], ticketIds: tickets, workType: "implementation",
  };
}

test("attribute groups sessions per ticket; explicit tickets always present", () => {
  const evidence: DayEvidence = {
    date: "2026-07-31",
    sessions: [sess("a", ["100"], 60), sess("b", ["100", "200"], 120), sess("c", [], 30)],
    git: [], redactedLineCount: 0,
  };
  const map = attribute({ evidence, tickets: [300] });
  assert.deepEqual([...map.keys()].sort(), [100, 200, 300]);
  assert.equal(map.get(100)!.length, 2);
  assert.equal(map.get(300)!.length, 0);
});

test("splitHours shares multi-ticket sessions and caps the day total", () => {
  const evidence: DayEvidence = {
    date: "2026-07-31",
    sessions: [sess("a", ["100"], 60), sess("b", ["100", "200"], 120)],
    git: [], redactedLineCount: 0,
  };
  const map = attribute({ evidence });
  const hours = splitHours(map, rules);
  // ticket 100: 60 + 120/2 = 120m = 2h; ticket 200: 60m = 1h
  assert.equal(hours.get(100), 2);
  assert.equal(hours.get(200), 1);
  // day cap: one 20h session gets scaled to 14
  const big = attribute({ evidence: { date: "d", sessions: [sess("x", ["1"], 20 * 60)], git: [], redactedLineCount: 0 } });
  assert.equal(splitHours(big, rules).get(1), 14);
});

test("dayRange covers the LOCAL day, not the UTC day", () => {
  const r = dayRange("2026-08-01");
  // local midnight boundaries, 24h wide
  assert.equal(r.endMs - r.startMs, 24 * 60 * 60 * 1000);
  // an instant 1 min after local midnight is in; 1 min before is out
  assert.equal(inRange(new Date(r.startMs + 60_000).toISOString(), r), true);
  assert.equal(inRange(new Date(r.startMs - 60_000).toISOString(), r), false);
  // east of UTC the range starts on the PREVIOUS UTC date — both must be scanned
  const offsetMin = new Date().getTimezoneOffset(); // IST = -330
  if (offsetMin < 0) assert.equal(r.utcDates.includes("2026-07-31"), true);
  assert.equal(r.utcDates.length >= 1 && r.utcDates.length <= 2, true);
});

test("rules deep-merge: user file setting only ado.org keeps default ticketIdPattern", () => {
  // mirrors loadRules' one-level-deep merge — the fresh-install regression
  const merged: Record<string, any> = {};
  for (const doc of [
    { ado: { org: "", project: "", ticketIdPattern: "[A-Z]{2,5}-(\\d+)" } }, // defaults
    { ado: { org: "myorg", project: "My Project" } }, // user file from `setup --org`
  ]) {
    for (const [k, v] of Object.entries(doc)) {
      const prev = merged[k];
      merged[k] =
        v && prev && typeof v === "object" && typeof prev === "object" && !Array.isArray(v) && !Array.isArray(prev)
          ? { ...prev, ...v }
          : v;
    }
  }
  assert.equal(merged.ado.org, "myorg");
  assert.equal(merged.ado.ticketIdPattern, "[A-Z]{2,5}-(\\d+)"); // must survive
});

test("localToday is the local calendar date", () => {
  const now = new Date();
  const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  assert.equal(localToday(), expected);
});

test("buildCreateOps pairs a Markdown format op for fields the rules mark as markdown", () => {
  const ops = buildCreateOps(
    "title",
    "## desc",
    { "Custom.Testsenarios": "1. scenario", "System.AssignedTo": "a@b.c" },
    ["Custom.Testsenarios"],
  );
  const paths = ops.map((o: any) => o.path);
  assert.equal(paths.includes("/fields/Custom.Testsenarios"), true);
  assert.equal(paths.includes("/multilineFieldsFormat/Custom.Testsenarios"), true); // paired op present
  assert.equal(paths.includes("/multilineFieldsFormat/System.AssignedTo"), false); // identity field: no format op
  assert.equal(paths.includes("/multilineFieldsFormat/System.Description"), true); // description always Markdown
});

test("legacy eod markers still match — old tickets update instead of duplicating", () => {
  // comments posted before v0.5.1 carry the visible footer; keep honouring it
  const legacy = "`eod:2026-08-01:461712ca,38869001`";
  assert.match(legacy, EOD_MARKER_RE);
  const comments = [
    { id: 1, text: "unrelated" },
    { id: 2, text: `**implementation** (2h)\n\n- work\n\n---\n${legacy}` },
    { id: 3, text: "old day\n\n---\n`eod:2026-07-31:x`" },
  ];
  assert.equal(findEodComment(comments, "2026-08-01"), comments[1]);
  assert.equal(findEodComment(comments, "2026-07-30"), undefined);
});

test("findEodComment: recorded id wins; same-day fallback needs author AND our header", () => {
  const day = new Date("2026-08-07T10:00:00Z").getTime();
  const win = { dayStartMs: day - 36e5, dayEndMs: day + 36e5, author: "Ramana Balaji" };
  const mine = { id: 9, text: "**implementation** (2h)\n\n- did a thing", createdBy: "Ramana Balaji", createdDate: "2026-08-07T10:00:00Z" };
  const handWritten = { id: 10, text: "Please also check the staging deploy", createdBy: "Ramana Balaji", createdDate: "2026-08-07T11:00:00Z" };
  const someoneElse = { id: 11, text: "**implementation** (1h)\n\n- x", createdBy: "Other Person", createdDate: "2026-08-07T10:00:00Z" };

  // the locally recorded id is authoritative
  assert.equal(findEodComment([mine, handWritten], "2026-08-07", { ...win, knownId: 10 }), handWritten);
  // no record → recognise our own generated comment by shape + author + day
  assert.equal(findEodComment([handWritten, mine, someoneElse], "2026-08-07", win), mine);
  // never adopt a hand-written note or another person's comment
  assert.equal(findEodComment([handWritten, someoneElse], "2026-08-07", win), undefined);
  // outside the day window → not today's
  assert.equal(findEodComment([mine], "2026-08-07", { ...win, dayStartMs: day + 72e5, dayEndMs: day + 108e5 }), undefined);
  // no author/window (unknown identity) → err toward a new comment
  assert.equal(findEodComment([mine], "2026-08-07"), undefined);
});

test("cumulative hours math: add to current, floor remaining at 0", () => {
  // mirrors applyWorkItem's arithmetic — the invariant that must never regress
  const current = { completed: 4.5, remaining: 2 };
  const todays = 2.5;
  const newCompleted = current.completed + todays;
  const newRemaining = Math.max(0, current.remaining - todays);
  assert.equal(newCompleted, 7);
  assert.equal(newRemaining, 0);
});

test("repoHasSession: session editing files in a repo counts even when cwd is elsewhere", () => {
  // real case 2026-08-01: session cwd was ~/Documents/Symphony but it edited 30+ files
  // and made 11 commits under ~/Documents/ado-eod — must not be marked git-only
  const repo = "/Users/bcs094/Documents/ado-eod";
  const symphonySession = { cwd: "/Users/bcs094/Documents/Symphony", files: ["/Users/bcs094/Documents/ado-eod/src/worklog.ts"] };
  assert.equal(repoHasSession(repo, [symphonySession]), true);
  // cwd match still works, including cwd deeper than repo and with no files
  assert.equal(repoHasSession(repo, [{ cwd: "/Users/bcs094/Documents/ado-eod/src", files: [] }]), true);
  // no overlap → git-only; prefix sibling "/…/ado-eod2" must not match via files
  assert.equal(repoHasSession(repo, [{ cwd: "/Users/bcs094/Documents/Symphony", files: ["/Users/bcs094/Documents/ado-eod2/x.ts"] }]), false);
  assert.equal(repoHasSession(repo, [{ cwd: undefined, files: [] }]), false);
});

test("eod_draft returns rev — eod_post requires it, so a draft without it is unpostable", async () => {
  // user-reported: drafts came back without System.Rev and every eod_post was blocked
  const draftRules = {
    ...rules,
    applies: { projects: [], workItemTypes: [], onlyMyTickets: false, blockStates: [] },
    comment: { format: "markdown", required: [], template: "{{date}}: {{summary}}", signoffTemplate: "" },
    completion: { maxProposedState: "Resolved", requireTester: false },
  } as Rules;
  const fakeAdo = {
    getWorkItem: async (id: number) => ({
      id, rev: 7,
      fields: { "System.Title": "T", "System.WorkItemType": "Task", "System.State": "Active", "System.TeamProject": "p" },
    }),
    getComments: async () => [],
  } as any;
  const evidence: DayEvidence = { date: "2026-08-05", sessions: [], git: [], redactedLineCount: 0 };
  const { drafts } = await buildDrafts(fakeAdo, draftRules, { evidence, tickets: [21637] });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].rev, 7);
  assert.equal(drafts[0].error, undefined);
});

test("draft auto-fills summary/next from evidence — never interrogates for daily updates", async () => {
  const draftRules = {
    ...rules,
    applies: { projects: [], workItemTypes: [], onlyMyTickets: false, blockStates: [] },
    comment: {
      format: "markdown",
      required: ["summary", "next", "testScenarios", "description", "acceptanceCriteria"],
      template: "{{summary}}\n\nNext: {{next}}",
      signoffTemplate: "",
    },
    completion: { maxProposedState: "Resolved", requireTester: true },
  } as Rules;
  const fakeAdo = {
    getWorkItem: async (id: number) => ({
      id, rev: 3,
      fields: { "System.Title": "Fix login redirect", "System.WorkItemType": "Bug", "System.State": "Active", "System.TeamProject": "p" },
    }),
    getComments: async () => [],
  } as any;
  const evidence: DayEvidence = {
    date: "2026-08-05",
    sessions: [],
    git: [{ repo: "/r/app", branch: "AB-42-login", commits: ["fix redirect loop", "add regression test"], ticketIds: ["42"], hasSession: true }],
    redactedLineCount: 0,
  };
  // no notes passed — the server must fill everything itself
  const { drafts } = await buildDrafts(fakeAdo, draftRules, { evidence, tickets: [42] });
  const d = drafts[0];
  assert.equal(d.missingSections.length, 0, `no questions for a daily update, got: ${d.missingSections}`);
  assert.equal(d.commentMarkdown.includes("fix redirect loop"), true);
  assert.equal(d.commentMarkdown.includes("Continue: Fix login redirect."), true);
  assert.deepEqual(d.autoFilled.sort(), ["headline", "next", "summary"]);
  // explicit notes win over the auto summary
  const { drafts: d2 } = await buildDrafts(fakeAdo, draftRules, { evidence, tickets: [42], notes: "Chased the redirect loop." });
  assert.equal(d2[0].commentMarkdown.includes("- Chased the redirect loop"), true); // bulleted, period trimmed
  assert.equal(d2[0].autoFilled.includes("summary"), false);
});

test("extractTicketIds is case-sensitive and numeric-only — utf-8/iso-8859 are not tickets", () => {
  const p = rules.ado.ticketIdPattern;
  assert.deepEqual(extractTicketIds(["saved as utf-8 in /src/iso-8859/x.ts"], p), []);
  assert.deepEqual(extractTicketIds(["branch ab-123 is lowercase, AB-456 is real"], p), ["456"]);
  // group-less pattern must not produce NaN-bound ids like "AB-123"; id 0 dropped
  assert.deepEqual(extractTicketIds(["AB-123"], "AB-\\d+"), []);
  assert.deepEqual(extractTicketIds(["AB-0 and AB-9"], p), ["9"]);
});

test("pathsOverlap is segment-aware — sibling dirs never overlap", () => {
  assert.equal(pathsOverlap("/x/ado-eod-v2", "/x/ado-eod"), false);
  assert.equal(pathsOverlap("/x/ado-eod/src", "/x/ado-eod"), true);
  assert.equal(pathsOverlap("/x/ado-eod", "/x/ado-eod"), true);
  assert.equal(pathsOverlap(undefined, "/x"), false);
});

test("splitHours: rounded sum never exceeds the day cap", () => {
  // 6.75h + 7.25h raw = 14.0 (passes raw cap), rounds to 7.0 + 7.5 = 14.5 — must be shaved
  const s1 = { activeMinutes: 405 } as SessionRecord;
  const s2 = { activeMinutes: 435 } as SessionRecord;
  const byTicket = new Map([[1, [s1]], [2, [s2]]]);
  const out = splitHours(byTicket, rules);
  const total = [...out.values()].reduce((a, b) => a + b, 0);
  assert.equal(total <= rules.hours.maxPerDay, true, `total ${total} exceeds cap`);
});

test("testScenarios route to the org's field, not the comment (live mistake #2)", async () => {
  const draftRules = {
    ...rules,
    applies: { projects: [], workItemTypes: [], onlyMyTickets: false, blockStates: [] },
    comment: { format: "markdown", required: ["testScenarios"], template: "{{summary}}\n{{testScenariosSection}}", signoffTemplate: "" },
    completion: { maxProposedState: "Resolved", requireTester: false },
    testScenarioField: { Bug: "Microsoft.VSTS.TCM.ReproSteps" },
  } as Rules;
  const fakeAdo = {
    getWorkItem: async (id: number) => ({ id, rev: 1, fields: { "System.Title": "T", "System.WorkItemType": "Bug", "System.State": "Active", "System.TeamProject": "p" } }),
    getComments: async () => [],
  } as any;
  const evidence: DayEvidence = { date: "2026-08-06", sessions: [], git: [], redactedLineCount: 0 };
  const scenarios = ["login works in prod", "checkbox returns real values"];
  const { drafts } = await buildDrafts(fakeAdo, draftRules, { evidence, tickets: [21637], testScenarios: scenarios });
  const d = drafts[0];
  // routed to the mapped field…
  assert.deepEqual(d.fieldAppends, [{ field: "Microsoft.VSTS.TCM.ReproSteps", markdown: "- login works in prod\n- checkbox returns real values" }]);
  // …and NOT into the comment
  assert.equal(d.commentMarkdown.includes("login works in prod"), false);
  assert.equal(d.missingSections.length, 0);
  // no mapping for this type → comment fallback, with its own header
  const noMap = { ...draftRules, testScenarioField: {} } as Rules;
  const { drafts: d2 } = await buildDrafts(fakeAdo, noMap, { evidence, tickets: [21637], testScenarios: scenarios });
  assert.equal(d2[0].fieldAppends.length, 0);
  assert.equal(d2[0].commentMarkdown.includes("**Test scenarios**\n- login works in prod"), true);
});

test("scenario/AC fields auto-discover from the type's field list — custom processes, typos included", async () => {
  // the real org's field is literally "Test senarios" (Custom.Testsenarios) on a custom type
  const fakeAdo = {
    getTypeFields: async () => [
      { name: "Test senarios", referenceName: "Custom.Testsenarios" },
      { name: "Acceptance Criteria", referenceName: "Custom.AcceptCrit" },
    ],
  } as any;
  const r = { testScenarioField: {}, acceptanceCriteriaField: {} } as unknown as Rules;
  assert.equal(await resolveSectionField(fakeAdo, r, "Enhancement", "testScenarios"), "Custom.Testsenarios");
  assert.equal(await resolveSectionField(fakeAdo, r, "Enhancement", "acceptanceCriteria"), "Custom.AcceptCrit");
  // explicit mapping wins; no type or no match → undefined; broken ado call → undefined
  const mapped = { testScenarioField: { Enhancement: "Custom.Explicit" } } as unknown as Rules;
  assert.equal(await resolveSectionField(fakeAdo, mapped, "Enhancement", "testScenarios"), "Custom.Explicit");
  assert.equal(await resolveSectionField(fakeAdo, r, undefined, "testScenarios"), undefined);
  assert.equal(await resolveSectionField({ getTypeFields: undefined } as any, r, "Bug", "testScenarios"), undefined);
});

test("SCENARIO_HEADING_RE catches the live-mistake comment shapes", () => {
  assert.equal(SCENARIO_HEADING_RE.test("work done\n\n**Test scenarios**\n- a"), true);
  assert.equal(SCENARIO_HEADING_RE.test("## Test Senarios\n- a"), true);
  assert.equal(SCENARIO_HEADING_RE.test("ran the test scenarios locally in prose"), false);
});

test("discovered section fields get the Markdown format op in create ops", () => {
  // static markdownFields can't know org-custom fields — routing must add them
  const ops = buildCreateOps("T", "desc", { "Custom.Testsenarios": "- a" }, ["System.Description", "Custom.Testsenarios"]);
  const paths = ops.map((o: any) => o.path);
  assert.equal(paths.includes("/fields/Custom.Testsenarios"), true);
  assert.equal(paths.includes("/multilineFieldsFormat/Custom.Testsenarios"), true);
  assert.equal(paths.includes("/multilineFieldsFormat/System.Description"), true);
});

test("default comment template is compact — a typical draft stays well under the line cap", async () => {
  const draftRules = {
    ...rules,
    applies: { projects: [], workItemTypes: [], onlyMyTickets: false, blockStates: [] },
    comment: {
      format: "markdown", required: [], maxLines: 25,
      template: "**{{date}} — {{workType}}** ({{hours}}h)\n\n{{summary}}\n{{testScenariosSection}}\n**Next:** {{next}}",
      signoffTemplate: "",
    },
    completion: { maxProposedState: "Resolved", requireTester: false },
  } as Rules;
  const fakeAdo = {
    getWorkItem: async (id: number) => ({ id, rev: 1, fields: { "System.Title": "T", "System.WorkItemType": "Task", "System.State": "Active", "System.TeamProject": "p" } }),
    getComments: async () => [],
    getTypeFields: async () => [],
  } as any;
  const evidence: DayEvidence = {
    date: "2026-08-06", sessions: [],
    git: [{ repo: "/r/a", branch: "b", commits: ["one", "two", "three", "four", "five", "six"], ticketIds: ["7"], hasSession: true }],
    redactedLineCount: 0,
  };
  const { drafts } = await buildDrafts(fakeAdo, draftRules, { evidence, tickets: [7], testScenarios: ["checked x", "checked y"] });
  const lines = drafts[0].commentMarkdown.split("\n").length;
  assert.equal(lines <= 25, true, `compact template rendered ${lines} lines`); // must fit the enforced cap
});

test("toBullets: prose, newline lists and existing bullets all become clean bullets", () => {
  assert.equal(toBullets("Did A. Then did B."), "- Did A\n- Then did B");
  assert.equal(toBullets("* one\n* two"), "- one\n- two");
  assert.equal(toBullets("1. one\n2) two"), "- one\n- two");
  assert.equal(toBullets("  single fact  "), "- single fact");
  assert.equal(toBullets(""), "");
});

test("proseLines flags paragraph comments, allows bullets/headers/signoff", () => {
  const good = "**implementation** — 2026-08-06\n\n**Summary:** Login work continued.\n\n- did a thing\n- did another\n\n**Next:** more";
  assert.deepEqual(proseLines(good), []);
  const bad = "**implementation** (2h)\n\nBuilt the Maestro provider configuration form across the React front-end.\n- ok";
  assert.equal(proseLines(bad).length, 1);
  assert.equal(proseLines(bad)[0].startsWith("Built the Maestro"), true);
});

test("draft comment is bulleted and contains no date and no eod marker", async () => {
  const draftRules = {
    ...rules,
    applies: { projects: [], workItemTypes: [], onlyMyTickets: false, blockStates: [] },
    comment: {
      format: "markdown", required: [], maxLines: 25,
      template: "**{{workType}}** ({{hours}}h)\n\n{{summary}}\n{{testScenariosSection}}\n**Next:** {{next}}",
      signoffTemplate: "",
    },
    completion: { maxProposedState: "Resolved", requireTester: false },
  } as Rules;
  const fakeAdo = {
    getWorkItem: async (id: number) => ({ id, rev: 1, fields: { "System.Title": "Fix login", "System.WorkItemType": "Task", "System.State": "Active", "System.TeamProject": "p" } }),
    getComments: async () => [],
    getTypeFields: async () => [],
  } as any;
  const evidence: DayEvidence = {
    date: "2026-08-06", sessions: [],
    git: [{ repo: "/r/a", branch: "b", commits: ["fix redirect", "add test"], ticketIds: ["42"], hasSession: true }],
    redactedLineCount: 0,
  };
  const { drafts } = await buildDrafts(fakeAdo, draftRules, { evidence, tickets: [42] });
  const c = drafts[0].commentMarkdown;
  assert.deepEqual(proseLines(c), [], `comment has prose: ${proseLines(c)}`);
  assert.equal(c.includes("- fix redirect"), true);
  // the ticket shows only human content: no date echo, no `eod:` footer
  assert.equal((c.match(/2026-08-06/g) ?? []).length, 0);
  assert.equal(EOD_MARKER_RE.test(c), false);
  assert.equal(c.includes("eod:"), false);
});

test("buildCreateOps emits the Hierarchy-Reverse parent link, and only when asked", () => {
  const withParent = buildCreateOps("Story A", "desc", {}, [], "https://dev.azure.com/o/_apis/wit/workItems/100");
  const rel = withParent.find((o: any) => o.path === "/relations/-");
  assert.equal(rel.value.rel, "System.LinkTypes.Hierarchy-Reverse"); // reverse = "parent is 100"
  assert.equal(rel.value.url.endsWith("/workItems/100"), true);
  // the link op comes after the field ops — ADO rejects relations before fields on create
  assert.equal(withParent.indexOf(rel) === withParent.length - 1, true);
  assert.equal(buildCreateOps("T", undefined, {}, []).some((o: any) => o.path === "/relations/-"), false);
});

test("ruleErrors extracts every failing field from an ADO error body (defect 2)", () => {
  const body = JSON.stringify({
    $id: "1",
    customProperties: {
      RuleValidationErrors: [
        { fieldReferenceName: "Custom.Testsenarios", errorMessage: "TF401320: Rule Error for field Test senarios.", fieldStatus: "InvalidEmpty" },
        { fieldReferenceName: "Custom.Complexity", errorMessage: "TF401320: Rule Error for field Complexity.", fieldStatus: "InvalidEmpty" },
      ],
    },
    message: "TF401320: Rule Error",
  });
  const errs = ruleErrors(body);
  assert.deepEqual(errs.map((e) => e.field), ["Custom.Testsenarios", "Custom.Complexity"]);
  assert.equal(errs[0].message.includes("InvalidEmpty"), true);
  // single-field variant and garbage must not throw
  assert.equal(ruleErrors(JSON.stringify({ customProperties: { FieldReferenceName: "Custom.X" }, message: "boom" }))[0].field, "Custom.X");
  assert.deepEqual(ruleErrors("<html>not json"), []);
});

test("missingRequiredFields lists what the template demands and the caller didn't send", () => {
  const tf = [
    { name: "Title", referenceName: "System.Title", alwaysRequired: true, defaultValue: null },
    { name: "State", referenceName: "System.State", alwaysRequired: true, defaultValue: null },
    { name: "Test senarios", referenceName: "Custom.Testsenarios", alwaysRequired: true, defaultValue: null },
    { name: "Complexity", referenceName: "Custom.Complexity", alwaysRequired: true, defaultValue: "Medium" },
    { name: "Notes", referenceName: "Custom.Notes", alwaysRequired: false, defaultValue: null },
  ];
  // Title/State are filled by ADO or the create itself; Complexity has a default
  assert.deepEqual(missingRequiredFields(tf, {}), [{ field: "Custom.Testsenarios", name: "Test senarios" }]);
  // supplying it clears the check
  assert.deepEqual(missingRequiredFields(tf, { "Custom.Testsenarios": "- a" }), []);
  // empty string counts as missing — that is exactly what triggers InvalidEmpty
  assert.equal(missingRequiredFields(tf, { "Custom.Testsenarios": "" }).length, 1);
});

test("comment carries a PM headline, the date once in the header, and no eod footer", async () => {
  const draftRules = {
    ...rules,
    applies: { projects: [], workItemTypes: [], onlyMyTickets: false, blockStates: [] },
    comment: {
      format: "markdown", required: [], maxLines: 25,
      template: "**{{workType}}** — {{date}}\n\n{{headlineSection}}\n{{summary}}\n{{testScenariosSection}}\n**Next:** {{next}}",
      signoffTemplate: "",
    },
    completion: { maxProposedState: "Resolved", requireTester: false },
  } as Rules;
  const fakeAdo = {
    getWorkItem: async (id: number) => ({ id, rev: 1, fields: { "System.Title": "Echo DB backend status", "System.WorkItemType": "Task", "System.State": "Active", "System.TeamProject": "p" } }),
    getComments: async () => [], getTypeFields: async () => [],
  } as any;
  const evidence: DayEvidence = {
    date: "2026-08-07", sessions: [],
    git: [{ repo: "/r/echo", branch: "b", commits: ["add read-only database block"], ticketIds: ["21637"], hasSession: true }],
    redactedLineCount: 0,
  };
  // caller supplies the plain-English line
  const { drafts } = await buildDrafts(fakeAdo, draftRules, {
    evidence, tickets: [21637],
    headline: "Admin screen now shows which database the service is using.",
  });
  const c = drafts[0].commentMarkdown;
  assert.equal(c.includes("**Summary:** Admin screen now shows which database the service is using."), true);
  assert.equal(drafts[0].headline?.includes("Admin screen"), true);
  // date exactly once, in the header — and never an eod footer
  assert.equal((c.match(/2026-08-07/g) ?? []).length, 1);
  assert.equal(c.split("\n")[0], "**implementation** — 2026-08-07");
  assert.equal(LEGACY_FOOTER_RE.test(c), false);
  assert.deepEqual(proseLines(c), []); // the headline is a labelled line, not loose prose

  // no headline supplied → generated, still one line, and flagged as auto-filled
  const { drafts: auto } = await buildDrafts(fakeAdo, draftRules, { evidence, tickets: [21637] });
  assert.equal(auto[0].autoFilled.includes("headline"), true);
  assert.equal(auto[0].headline!.split("\n").length, 1);
  assert.equal(auto[0].headline!.includes("Echo DB backend status"), true);
});

test("LEGACY_FOOTER_RE catches the footer shapes eod_post must reject", () => {
  assert.equal(LEGACY_FOOTER_RE.test("work\n\n---\n`eod:2026-08-07:461712ca`"), true);
  assert.equal(LEGACY_FOOTER_RE.test("work\n\neod:2026-08-07:"), true); // unfenced
  assert.equal(LEGACY_FOOTER_RE.test("- shipped on 2026-08-07"), false); // a real date in content is fine
});
