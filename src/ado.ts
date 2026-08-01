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
    this.baseProject = `${this.base}/${encodeURIComponent(rules.ado.project)}`;
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
    const t = await this.credential.getToken(SCOPE);
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
      throw new Error(`ADO ${method} ${url} → ${res.status}: ${text.slice(0, 400)}`);
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

  async getComments(id: number): Promise<Array<{ id: number; text: string; createdBy: string; createdDate: string }>> {
    const r = await this.req("GET", `${this.baseProject}/_apis/wit/workItems/${id}/comments?api-version=${API}-preview.4`);
    return (r.comments ?? []).map((c: any) => ({
      id: c.id, text: c.text ?? "",
      createdBy: c.createdBy?.displayName ?? "?", createdDate: c.createdDate,
    }));
  }

  async wiql(query: string): Promise<number[]> {
    const r = await this.req("POST", `${this.baseProject}/_apis/wit/wiql?api-version=${API}`, { query });
    return (r.workItems ?? []).map((w: any) => w.id);
  }

  async getRevisions(id: number): Promise<Array<{ rev: number; changedBy: string; changedDate: string; state?: string }>> {
    const r = await this.req("GET", `${this.base}/_apis/wit/workitems/${id}/revisions?api-version=${API}`);
    return (r.value ?? []).map((v: any) => ({
      rev: v.rev,
      changedBy: v.fields?.["System.ChangedBy"]?.displayName ?? v.fields?.["System.ChangedBy"] ?? "?",
      changedDate: v.fields?.["System.ChangedDate"],
      state: v.fields?.["System.State"],
    }));
  }

  /** Allowed states for a work item type — process templates differ (Agile vs Scrum). */
  async getAllowedStates(workItemType: string): Promise<string[]> {
    const r = await this.req(
      "GET",
      `${this.baseProject}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/states?api-version=${API}-preview.1`,
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

  async addComment(id: number, text: string, format: "markdown" | "html"): Promise<void> {
    if (format === "markdown") {
      // format param is newer than the 7.0 API surface; fall back to HTML if the org rejects it
      try {
        await this.req(
          "POST",
          `${this.baseProject}/_apis/wit/workItems/${id}/comments?format=markdown&api-version=${API}-preview.4`,
          { text },
        );
        this.commentsMarkdownSupported = true;
        return;
      } catch {
        this.commentsMarkdownSupported = false;
      }
    }
    await this.req("POST", `${this.baseProject}/_apis/wit/workItems/${id}/comments?api-version=${API}-preview.4`, { text });
  }

  /** Replace an existing comment's text — same-day re-runs update, never duplicate. */
  async updateComment(id: number, commentId: number, text: string, format: "markdown" | "html"): Promise<void> {
    const fmt = format === "markdown" && this.commentsMarkdownSupported !== false ? "&format=markdown" : "";
    try {
      await this.req(
        "PATCH",
        `${this.baseProject}/_apis/wit/workItems/${id}/comments/${commentId}?api-version=${API}-preview.4${fmt}`,
        { text },
      );
    } catch {
      // format param rejected by older orgs — retry plain
      await this.req(
        "PATCH",
        `${this.baseProject}/_apis/wit/workItems/${id}/comments/${commentId}?api-version=${API}-preview.4`,
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
  ): Promise<WorkItem> {
    return this.req(
      "POST",
      `${this.baseProject}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=${API}`,
      buildCreateOps(title, descriptionMarkdown, extra, markdownFields),
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
  return ops;
}
