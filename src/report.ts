import { AdoClient } from "./ado.js";

export type ReportView = "progress" | "people" | "breakdown" | "timeline";

export interface ReportArgs {
  project: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  person?: string;
  view: ReportView;
}

const F = {
  id: "System.Id", title: "System.Title", state: "System.State",
  type: "System.WorkItemType", assigned: "System.AssignedTo",
  changed: "System.ChangedDate", created: "System.CreatedDate",
  parent: "System.Parent",
  completed: "Microsoft.VSTS.Scheduling.CompletedWork",
  remaining: "Microsoft.VSTS.Scheduling.RemainingWork",
};

function displayName(v: any): string {
  return v?.displayName ?? (typeof v === "string" ? v : "unassigned");
}

const EOD_MARKER = /^<!-- eod:/;

export async function report(ado: AdoClient, args: ReportArgs): Promise<any> {
  const personClause = args.person ? ` AND [System.AssignedTo] CONTAINS '${args.person.replace(/'/g, "''")}'` : "";
  const ids = await ado.wiql(
    `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${args.project.replace(/'/g, "''")}'` +
      ` AND [System.ChangedDate] >= '${args.from}' AND [System.ChangedDate] <= '${args.to}'${personClause}` +
      ` ORDER BY [System.ChangedDate] DESC`,
  );
  const items = await ado.getWorkItems(ids.slice(0, 400)); // WIQL caps at ~20k; reads capped sanely
  const truncated = ids.length > 400 ? ids.length - 400 : 0;

  switch (args.view) {
    case "progress": {
      const byState: Record<string, number> = {};
      let completedSum = 0, remainingSum = 0;
      const closedInRange: any[] = [], openedInRange: any[] = [];
      for (const it of items) {
        const st = it.fields[F.state];
        byState[st] = (byState[st] ?? 0) + 1;
        completedSum += it.fields[F.completed] ?? 0;
        remainingSum += it.fields[F.remaining] ?? 0;
        if (["Closed", "Done", "Resolved"].includes(st)) closedInRange.push(brief(it));
        if ((it.fields[F.created] ?? "") >= args.from) openedInRange.push(brief(it));
      }
      // quote EOD comments where they exist — the payoff for writing them
      const highlights: any[] = [];
      for (const it of items.slice(0, 25)) {
        const comments = await ado.getComments(it.id);
        const eod = comments.filter((c) => EOD_MARKER.test(c.text));
        if (eod.length) highlights.push({ id: it.id, title: it.fields[F.title], latestEod: eod[eod.length - 1].text.slice(0, 600) });
      }
      return { view: "progress", range: [args.from, args.to], byState, completedHours: completedSum, remainingHours: remainingSum, closedInRange, openedInRange, eodHighlights: highlights, truncated };
    }
    case "people": {
      const byPerson: Record<string, { active: any[]; lastActivity: string }> = {};
      for (const it of items) {
        const who = displayName(it.fields[F.assigned]);
        byPerson[who] ??= { active: [], lastActivity: "" };
        byPerson[who].active.push(brief(it));
        const ch = it.fields[F.changed] ?? "";
        if (ch > byPerson[who].lastActivity) byPerson[who].lastActivity = ch;
      }
      return { view: "people", range: [args.from, args.to], byPerson, truncated };
    }
    case "breakdown": {
      const byId = new Map(items.map((i) => [i.id, i]));
      const roots: any[] = [];
      const children = new Map<number, any[]>();
      for (const it of items) {
        const parent = it.fields[F.parent];
        if (parent && byId.has(parent)) {
          children.set(parent, [...(children.get(parent) ?? []), it]);
        } else {
          roots.push(it);
        }
      }
      const node = (it: any): any => ({
        ...brief(it),
        children: (children.get(it.id) ?? []).map(node),
      });
      return { view: "breakdown", range: [args.from, args.to], tree: roots.map(node), truncated };
    }
    case "timeline": {
      const events: any[] = [];
      for (const it of items.slice(0, 40)) {
        const revs = await ado.getRevisions(it.id);
        let prevState: string | undefined;
        for (const r of revs) {
          if ((r.changedDate ?? "") < args.from || (r.changedDate ?? "") > `${args.to}T23:59:59`) { prevState = r.state; continue; }
          if (r.state !== prevState) {
            events.push({ date: r.changedDate, id: it.id, title: it.fields[F.title], change: `${prevState ?? "·"} → ${r.state}`, by: r.changedBy });
          }
          prevState = r.state;
        }
        const comments = await ado.getComments(it.id);
        for (const c of comments) {
          if (c.createdDate >= args.from && c.createdDate <= `${args.to}T23:59:59`) {
            events.push({ date: c.createdDate, id: it.id, title: it.fields[F.title], comment: c.text.slice(0, 400), by: c.createdBy });
          }
        }
      }
      events.sort((a, b) => (a.date < b.date ? -1 : 1));
      return { view: "timeline", range: [args.from, args.to], events, truncated: truncated + Math.max(0, items.length - 40) };
    }
  }
}

function brief(it: any) {
  return {
    id: it.id,
    type: it.fields[F.type],
    title: it.fields[F.title],
    state: it.fields[F.state],
    assignedTo: displayName(it.fields[F.assigned]),
    completed: it.fields[F.completed],
    remaining: it.fields[F.remaining],
  };
}
