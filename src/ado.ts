import {
  ChainedTokenCredential,
  AzureCliCredential,
  InteractiveBrowserCredential,
  DeviceCodeCredential,
  useIdentityPlugin,
  serializeAuthenticationRecord,
  deserializeAuthenticationRecord,
  AuthenticationRecord,
  TokenCredential,
} from "@azure/identity";
import { cachePersistencePlugin } from "@azure/identity-cache-persistence";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export interface TypeField {
  name: string;
  referenceName: string;
  /** The process template refuses a create without this field. */
  alwaysRequired: boolean;
  defaultValue: unknown;
}

/**
 * Every field ADO refused, from a work-item error body. The list lives in
 * RuleValidationErrors[]; customProperties carries a single-field variant.
 */
export function ruleErrors(body: string): Array<{ field: string; message: string }> {
  let doc: any;
  try {
    doc = JSON.parse(body);
  } catch {
    return [];
  }
  const out: Array<{ field: string; message: string }> = [];
  const list = doc?.customProperties?.RuleValidationErrors ?? doc?.RuleValidationErrors ?? [];
  for (const r of Array.isArray(list) ? list : []) {
    const field = r?.fieldReferenceName ?? r?.FieldReferenceName ?? r?.fieldName ?? "?";
    out.push({ field, message: [r?.errorMessage ?? r?.ErrorMessage, r?.fieldStatus ?? r?.FieldStatus].filter(Boolean).join(" ") || "rule error" });
  }
  if (!out.length) {
    const f = doc?.customProperties?.FieldReferenceName ?? doc?.customProperties?.FieldName;
    const m = doc?.message ?? doc?.customProperties?.errorMessage;
    if (f || m) out.push({ field: f ?? "?", message: m ?? "rule error" });
  }
  return out;
}

/**
 * A Linux box with no libsecret fails deep inside MSAL with a message that never
 * says "install libsecret" — so say it here, and only when that's plausibly it.
 */
export function cachePersistenceHint(e: Error, platform = process.platform, env = process.env): string {
  // Outside strict mode the keyring failure is absorbed by the 0600 file cache,
  // so there is no error to annotate.
  if (platform !== "linux" || env.ADO_EOD_STRICT_CACHE !== "1") return "";
  if (!/secret|keyring|persistence|encrypt/i.test(e.message)) return "";
  return " — on Linux the token cache needs libsecret (`apt install libsecret-1-dev`, `yum install libsecret-devel`); or unset ADO_EOD_STRICT_CACHE to cache in a 0600 file instead, or set ADO_EOD_PAT";
}

/**
 * Whether to let MSAL keep the cache in a plaintext 0600 file when the OS keyring
 * is unreachable. WSL, Codespaces and slim containers ship no libsecret/D-Bus at
 * all, and refusing there means a fresh browser sign-in on every single call —
 * so default to the file, matching what `az` itself does on Linux, and let the
 * security-conscious force the strict behaviour back on.
 */
export function allowPlaintextCache(env = process.env): boolean {
  return env.ADO_EOD_STRICT_CACHE !== "1";
}

/**
 * No browser to open — SSH sessions, containers, headless CI. InteractiveBrowser
 * would spend two minutes failing to launch one; device code prints a URL and a
 * code instead and works anywhere.
 */
export function isHeadless(env = process.env, platform = process.platform): boolean {
  if (env.ADO_EOD_DEVICE_CODE === "1") return true;
  if (platform !== "linux") return false; // mac/Windows always have a way to open a browser
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return false; // WSL hands off to the Windows browser
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
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
      // Without an AuthenticationRecord, InteractiveBrowserCredential ignores the
      // persisted token cache and opens the browser on every new process. Load a
      // saved record so later processes acquire silently; the first interactive
      // sign-in saves it (see below).
      const recordPath = join(homedir(), ".ado-eod", "auth-record.json");
      let record: AuthenticationRecord | undefined;
      try {
        record = deserializeAuthenticationRecord(readFileSync(recordPath, "utf8"));
      } catch {} // no record yet — first sign-in saves one
      // Encryption backend is per-OS: Keychain (mac), DPAPI (Windows), libsecret
      // (Linux). Only the Linux and macOS branches honour this flag; Windows always
      // has DPAPI, so it is a no-op there.
      const tokenCachePersistenceOptions = { enabled: true, unsafeAllowUnencryptedStorage: allowPlaintextCache() };
      const interactive: TokenCredential & { authenticate(scope: string): Promise<AuthenticationRecord | undefined> } =
        isHeadless()
          ? new DeviceCodeCredential({
              tokenCachePersistenceOptions,
              authenticationRecord: record,
              // the default callback console.log()s, and stdout is the MCP JSON-RPC
              // channel — anything written there corrupts the protocol
              userPromptCallback: (info) => console.error(`ado-eod sign-in: ${info.message}`),
            })
          : new InteractiveBrowserCredential({
              redirectUri: "http://localhost:8400",
              tokenCachePersistenceOptions,
              authenticationRecord: record,
              // getToken() bypasses the public authenticate(), so hook the record here
              disableAutomaticAuthentication: false,
            });
      const saveRecord = async () => {
        if (record) return; // already have one on disk
        try {
          const rec = await interactive.authenticate(SCOPE);
          if (rec) {
            mkdirSync(join(homedir(), ".ado-eod"), { recursive: true });
            writeFileSync(recordPath, serializeAuthenticationRecord(rec), { mode: 0o600 });
          }
        } catch (e) {
          // worst case: browser prompt again next run — not fatal, but say why on stderr
          console.error(`ado-eod: could not persist sign-in (${(e as Error).message}) — browser will prompt again`);
        }
      };
      // authenticate() both runs the interactive flow (or hits cache) and returns
      // the record, so route the browser leg of the chain through it
      this.credential = new ChainedTokenCredential(new AzureCliCredential(), {
        getToken: async (scopes, options) => {
          await saveRecord();
          try {
            return await interactive.getToken(scopes, options);
          } catch (e) {
            throw new Error(`${(e as Error).message}${cachePersistenceHint(e as Error)}`);
          }
        },
      });
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
          () =>
            rej(
              new Error(
                `${isHeadless() ? "device-code sign-in" : "browser sign-in"} not completed within 2 minutes — ask the user to retry and finish signing in, or use \`az login\` / set ADO_EOD_PAT`,
              ),
            ),
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
      // The 400 that matters most is a field-rule rejection, and RuleValidationErrors[]
      // names every failing field — truncating the body hides exactly what to fix, so
      // pull it out and put it FIRST, before any clipping.
      const rule = ruleErrors(text);
      const detail = rule.length
        ? `${rule.map((r) => `${r.field}: ${r.message}`).join(" | ")} — full body: ${text.slice(0, 2000)}`
        : text.slice(0, 2000);
      const err: any = new Error(`ADO ${method} ${url} → ${res.status}: ${detail}`);
      err.status = res.status; // callers distinguish "param rejected" (4xx) from transient failures
      err.ruleErrors = rule;
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

  private typeFieldsCache = new Map<string, TypeField[]>();

  /**
   * Fields on a work item type, including which ones the process template makes
   * mandatory ($expand=all yields alwaysRequired). Drives both custom-field discovery
   * and the pre-flight required-field check, so a fresh org needs no YAML.
   */
  async getTypeFields(type: string, project?: string): Promise<TypeField[]> {
    const key = `${project ?? ""}:${type}`;
    const hit = this.typeFieldsCache.get(key);
    if (hit) return hit;
    const r = await this.req(
      "GET",
      `${this.scope(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/fields?$expand=all&api-version=${API}`,
    ).catch(() => ({ value: [] }));
    const fields: TypeField[] = (r.value ?? []).map((f: any) => ({
      name: f.name ?? "",
      referenceName: f.referenceName ?? "",
      alwaysRequired: Boolean(f.alwaysRequired),
      defaultValue: f.defaultValue ?? null,
    }));
    this.typeFieldsCache.set(key, fields);
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

  async addComment(id: number, text: string, format: "markdown" | "html", project?: string): Promise<{ id?: number }> {
    if (format === "markdown") {
      try {
        const r = await this.req(
          "POST",
          `${this.scope(project)}/_apis/wit/workItems/${id}/comments?format=markdown&api-version=${API}-preview.4`,
          { text },
        );
        this.commentsMarkdownSupported = true;
        return { id: r?.id }; // caller records this to keep re-runs idempotent
      } catch (e) {
        // a transient 500 / network drop must NOT flag markdown unsupported forever,
        // and must not re-POST (the first request may have committed → duplicate comment)
        if (!AdoClient.formatRejected(e)) throw e;
        this.commentsMarkdownSupported = false;
      }
    }
    const r = await this.req("POST", `${this.scope(project)}/_apis/wit/workItems/${id}/comments?api-version=${API}-preview.4`, { text });
    return { id: r?.id };
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
