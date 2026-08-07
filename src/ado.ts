import { ChainedTokenCredential, AzureCliCredential, InteractiveBrowserCredential, useIdentityPlugin } from "@azure/identity";
import { cachePersistencePlugin } from "@azure/identity-cache-persistence";
import { Rules } from "./rules.js";

// Azure DevOps first-party resource id — constant across all orgs.
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const SCOPE = `${ADO_RESOURCE}/.default`;
const API = "7.1";

useIdentityPlugin(cachePersistencePlugin);

export interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, any>;
}

export class AdoClient {
  private credential: ChainedTokenCredential | null = null;
  private base: string;
  private baseProject: string;
  commentsMarkdownSupported: boolean | null = null; // probed lazily

  constructor(private rules: Rules) {
    this.base = `https://dev.azure.com/${rules.ado.org}`;
    this.baseProject = `${this.base}/${encodeURIComponent(rules.ado.project ?? "")}`;
  }

  /**
   * Project-scoped URL base. People work across several projects, so callers pass the
   * ticket's own System.TeamProject instead of relying on one configured default.
   */
  private scope(project?: string): string {
    return project ? `${this.base}/${encodeURIComponent(project)}` : this.baseProject;
  }

  /** The project a work item actually lives in — org-scoped read, no project needed. */
  async getProjectOf(id: number): Promise<string | undefined> {
    const wi = await this.getWorkItem(id);
    return wi.fields?.["System.TeamProject"];
  }

  private async token(): Promise<string> {
    // PAT fallback: one env var, no keychain code of ours (Phase 1b documented path)
    const pat = process.env.ADO_EOD_PAT;
    if (pat) return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
    if (!this.credential) {
      this.credential = new ChainedTokenCredential(
        new AzureCliCredential(),
        new InteractiveBrowserCredential({
          redirectUri: "http://localhost:8400",
          tokenCachePersistenceOptions: { enabled: true },
        }),
      );
    }
    // never hang a tool call on an abandoned browser prompt — fail with instructions instead
    const pending = this.credential.getToken(SCOPE);
    // if the timeout wins, this orphaned promise may still reject later — an unhandled
    // rejection would kill the whole MCP server process
    pending.catch(() => {});
    const t = await Promise.race([
      pending,
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error("browser sign-in not completed within 2 minutes — ask the user to retry and finish the sign-in window, or use `az login` / set ADO_EOD_PAT")),
          120_000,
        ).unref(),
      ),
    ]);
    return `Bearer ${t.token}`;
  }

  private async req(method: string, url: string, body?: unknown, contentType = "application/json"): Promise<any> {
    const auth = await this.token();
    const res = await fetch(url, {
      method,
      headers: { Authorization: auth, "Content-Type": contentType },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err: any = new Error(`ADO ${method} ${url} → ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status; // callers distinguish "param rejected" (4xx) from transient failures
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  // ---------- Phase 1a: reads ----------

  async getWorkItem(id: number): Promise<WorkItem> {
    return this.req("GET", `${this.base}/_apis/wit/workitems/${id}?$expand=fields&api-version=${API}`);
  }

  async getWorkItems(ids: number[]): Promise<WorkItem[]> {
    if (!ids.length) return [];
    const out: WorkItem[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const r = await this.req("GET", `${this.base}/_apis/wit/workitems?ids=${batch.join(",")}&api-version=${API}`);
      out.push(...(r.value ?? []));
    }
    return out;
  }

  async getComments(id: number, project?: string): Promise<Array<{ id: number; text: string; createdBy: string; createdDate: string }>> {
    // paginated, oldest first — the day's marker comment is exactly what falls off page 1
    // on long-lived tickets, which would break idempotency (duplicate comments, double hours)
    const all: any[] = [];
    let token: string | undefined;
    for (let page = 0; page < 50; page++) {
      const tk = token ? `&continuationToken=${encodeURIComponent(token)}` : "";
      const r = await this.req("GET", `${this.scope(project)}/_apis/wit/workItems/${id}/comments?$top=200${tk}&api-version=${API}-preview.4`);
      all.push(...(r.comments ?? []));
      token = r.continuationToken;
      if (!token) break;
    }
    return all.map((c: any) => ({
      id: c.id, text: c.text ?? "",
      createdBy: c.createdBy?.displayName ?? "?", createdDate: c.createdDate,
    }));
  }

  async wiql(query: string): Promise<number[]> {
    // org-scoped, not project-scoped: report queries name their own project in WHERE —
    // a project-scoped endpoint silently returns nothing for any other project
    const r = await this.req("POST", `${this.base}/_apis/wit/wiql?api-version=${API}`, { query });
    return (r.workItems ?? []).map((w: any) => w.id);
  }

  async getRevisions(id: number): Promise<Array<{ rev: number; changedBy: string; changedDate: string; state?: string }>> {
    // page through — busy items exceed the 200-per-page default and would lose newest history
    const value: any[] = [];
    for (let skip = 0; skip < 10_000; skip += 200) {
      const r = await this.req("GET", `${this.base}/_apis/wit/workitems/${id}/revisions?$top=200&$skip=${skip}&api-version=${API}`);
      value.push(...(r.value ?? []));
      if ((r.value ?? []).length < 200) break;
    }
    return value.map((v: any) => ({
      rev: v.rev,
      changedBy: v.fields?.["System.ChangedBy"]?.displayName ?? v.fields?.["System.ChangedBy"] ?? "?",
      changedDate: v.fields?.["System.ChangedDate"],
      state: v.fields?.["System.State"],
    }));
  }

  private typeFieldsCache = new Map<string, Array<{ name: string; referenceName: string }>>();

  /** Fields available on a work item type — used to auto-discover custom AC / test-scenario fields. */
  async getTypeFields(type: string, project?: string): Promise<Array<{ name: string; referenceName: string }>> {
    const hit = this.typeFieldsCache.get(`${project ?? ""}:${type}`);
    if (hit) return hit;
    const r = await this.req(
      "GET",
      `${this.scope(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/fields?api-version=${API}`,
    ).catch(() => ({ value: [] }));
    const fields = (r.value ?? []).map((f: any) => ({ name: f.name ?? "", referenceName: f.referenceName ?? "" }));
    this.typeFieldsCache.set(`${project ?? ""}:${type}`, fields);
    return fields;
  }

  /** Allowed states for a work item type — process templates differ (Agile vs Scrum). */
  async getAllowedStates(workItemType: string, project?: string): Promise<string[]> {
    const r = await this.req(
      "GET",
      `${this.scope(project)}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/states?api-version=${API}-preview.1`,
    );
    return (r.value ?? []).map((s: any) => s.name);
  }

  /** Resolve a person to an identity for @-mentions. Returns null if ambiguous/missing. */
  async resolveIdentity(name: string): Promise<{ id: string; displayName: string } | null> {
    const r = await this.req(
      "GET",
      `https://vssps.dev.azure.com/${this.rules.ado.org}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(name)}&api-version=${API}-preview.1`,
    ).catch(() => null);
    const matches = r?.value ?? [];
    if (matches.length !== 1) return null;
    return { id: matches[0].id, displayName: matches[0].providerDisplayName ?? matches[0].customDisplayName ?? name };
  }

  async whoAmI(): Promise<{ displayName: string; email: string }> {
    const r = await this.req("GET", `${this.base}/_apis/connectionData?api-version=${API}-preview.1`);
    return {
      displayName: r.authenticatedUser?.providerDisplayName ?? "?",
      email: r.authenticatedUser?.properties?.Account?.$value ?? "?",
    };
  }

  // ---------- Phase 1b: writes (gated by eod_post's confirmed flag upstream) ----------

  /** The markdown `format` param is rejected by older orgs with a 4xx — ONLY that means "unsupported". */
  private static formatRejected(e: any): boolean {
    return typeof e?.status === "number" && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403 && e.status !== 429;
  }

  async addComment(id: number, text: string, format: "markdown" | "html", project?: string): Promise<void> {
    if (format === "markdown") {
      try {
        await this.req(
          "POST",
          `${this.scope(project)}/_apis/wit/workItems/${id}/comments?format=markdown&api-version=${API}-preview.4`,
          { text },
        );
        this.commentsMarkdownSupported = true;
        return;
      } catch (e) {
        // a transient 500 / network drop must NOT flag markdown unsupported forever,
        // and must not re-POST (the first request may have committed → duplicate comment)
        if (!AdoClient.formatRejected(e)) throw e;
        this.commentsMarkdownSupported = false;
      }
    }
    await this.req("POST", `${this.scope(project)}/_apis/wit/workItems/${id}/comments?api-version=${API}-preview.4`, { text });
  }

  /** Replace an existing comment's text — same-day re-runs update, never duplicate. */
  async updateComment(id: number, commentId: number, text: string, format: "markdown" | "html", project?: string): Promise<void> {
    const fmt = format === "markdown" && this.commentsMarkdownSupported !== false ? "&format=markdown" : "";
    try {
      await this.req(
        "PATCH",
        `${this.scope(project)}/_apis/wit/workItems/${id}/comments/${commentId}?api-version=${API}-preview.4${fmt}`,
        { text },
      );
    } catch (e) {
      // only a rejected format param falls back to plain — surfacing the real error beats
      // storing markdown as HTML on a transient failure
      if (!fmt || !AdoClient.formatRejected(e)) throw e;
      await this.req(
        "PATCH",
        `${this.scope(project)}/_apis/wit/workItems/${id}/comments/${commentId}?api-version=${API}-preview.4`,
        { text },
      );
    }
  }

  /** Create a work item. Description goes in as Markdown (paired multilineFieldsFormat op). */
  async createWorkItem(
    type: string,
    title: string,
    descriptionMarkdown?: string,
    extra: Record<string, any> = {},
    markdownFields: string[] = [],
    project?: string,
    parentId?: number,
  ): Promise<WorkItem> {
    return this.req(
      "POST",
      `${this.scope(project)}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=${API}`,
      buildCreateOps(title, descriptionMarkdown, extra, markdownFields, parentId ? `${this.base}/_apis/wit/workItems/${parentId}` : undefined),
      "application/json-patch+json",
    );
  }

  /** Link an existing item under a parent (Feature → User Story → Task). */
  async linkToParent(id: number, rev: number, parentId: number): Promise<WorkItem> {
    return this.req(
      "PATCH",
      `${this.base}/_apis/wit/workitems/${id}?api-version=${API}`,
      [
        { op: "test", path: "/rev", value: rev },
        { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${this.base}/_apis/wit/workItems/${parentId}` } },
      ],
      "application/json-patch+json",
    );
  }

  /**
   * Update fields. Long-text fields get the paired multilineFieldsFormat op — without it
   * ADO silently stores Markdown as HTML. Sends rev test so concurrent edits fail loudly.
   */
  async updateWorkItem(id: number, rev: number, fields: Record<string, any>, markdownFields: string[] = []): Promise<WorkItem> {
    const ops: any[] = [{ op: "test", path: "/rev", value: rev }];
    for (const [k, v] of Object.entries(fields)) {
      ops.push({ op: "add", path: `/fields/${k}`, value: v });
    }
    for (const f of markdownFields) {
      // a format op without a matching value op is rejected ("type changed without a value")
      if (f in fields) ops.push({ op: "add", path: `/multilineFieldsFormat/${f}`, value: "Markdown" });
    }
    return this.req("PATCH", `${this.base}/_apis/wit/workitems/${id}?api-version=${API}`, ops, "application/json-patch+json");
  }
}

/** Pure op-builder for createWorkItem — extra fields listed in markdownFields get the paired format op. */
export function buildCreateOps(
  title: string,
  descriptionMarkdown: string | undefined,
  extra: Record<string, any>,
  markdownFields: string[],
  parentUrl?: string,
): any[] {
  const ops: any[] = [{ op: "add", path: "/fields/System.Title", value: title }];
  if (descriptionMarkdown) {
    ops.push({ op: "add", path: "/fields/System.Description", value: descriptionMarkdown });
    ops.push({ op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" });
  }
  for (const [k, v] of Object.entries(extra)) {
    ops.push({ op: "add", path: `/fields/${k}`, value: v });
    if (markdownFields.includes(k)) ops.push({ op: "add", path: `/multilineFieldsFormat/${k}`, value: "Markdown" });
  }
  // Hierarchy-Reverse = "my parent is X"; ADO enforces the type rules (Feature→Story→Task)
  if (parentUrl) ops.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl } });
  return ops;
}
