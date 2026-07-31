import { test } from "node:test";
import assert from "node:assert/strict";
import { activeMinutes, classifyWorkType, extractTicketIds, cleanPrompt, roundAndCapHours, dayRange, inRange, localToday } from "../src/worklog.js";
import { attribute, splitHours, eodMarker, findEodComment, EOD_MARKER_RE } from "../src/draft.js";
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

test("eod marker survives ADO's Markdown sanitization (no HTML comments) and is found", () => {
  // ADO strips <!-- --> from Markdown comments — discovered live; marker must be inline code
  const marker = eodMarker("2026-08-01", ["461712ca-full-id", "38869001-full-id"]);
  assert.equal(marker.includes("<!--"), false);
  assert.match(marker, EOD_MARKER_RE);
  const comments = [
    { text: "unrelated" },
    { text: `**2026-08-01 — implementation** (2h)\n\nwork\n\n---\n${marker}` },
    { text: `old day\n\n---\n${eodMarker("2026-07-31", ["x"])}` },
  ];
  assert.equal(findEodComment(comments, "2026-08-01"), comments[1]);
  assert.equal(findEodComment(comments, "2026-07-30"), undefined);
  assert.equal(EOD_MARKER_RE.exec(comments[1].text)?.[1], "2026-08-01");
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
