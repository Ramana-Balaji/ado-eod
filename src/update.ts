import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = "Ramana-Balaji/ado-eod";
const HOME = homedir();
const STATE_DIR = join(HOME, ".ado-eod");

/** Where a self-managed install lives. Owning this directory is what makes updates reliable — the npx cache is shared and never refreshes itself. */
export const APP_DIR = join(STATE_DIR, "app");
export const managedCli = () => join(APP_DIR, "node_modules", "ado-eod", "dist", "src", "cli.js");

export function currentVersion(): string {
  // dist/src/update.js → package.json is two levels up from dist/
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try {
      const p = fileURLToPath(new URL(rel, import.meta.url));
      const v = JSON.parse(readFileSync(p, "utf8")).version;
      if (v) return v;
    } catch {
      /* try the next candidate */
    }
  }
  return "0.0.0";
}

/** Compare semver-ish strings. Returns true when b is newer than a. */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.\-+]/).map((n) => (/^\d+$/.test(n) ? +n : 0));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

interface CheckState {
  lastCheckMs: number;
  latest: string;
  /** Last release we already installed — stops a re-install loop when a tag and package.json disagree. */
  installedLatest?: string;
}

const statePath = () => join(STATE_DIR, "update-check.json");

function readState(): CheckState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return { lastCheckMs: 0, latest: "0.0.0" };
  }
}

function writeState(s: CheckState): void {
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(s, null, 2) + "\n");
  } catch {
    /* a cache we cannot write just means we check again next time */
  }
}

/**
 * Latest published release tag. Never throws and never blocks for long — an update
 * check must not be able to break the tool it is checking.
 */
async function fetchLatest(timeoutMs = 4000): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "ado-eod" },
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const tag = (await r.json())?.tag_name;
    return typeof tag === "string" ? tag.replace(/^v/, "") : null;
  } catch {
    return null; // offline, rate-limited, DNS — all fine, just skip
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateStatus {
  current: string;
  latest?: string;
  updateAvailable: boolean;
  /** This release was already fetched to disk — waiting on a restart, not on a download. */
  alreadyInstalled?: boolean;
}

/** Cached version check. Hits the network at most once per intervalHours. */
export async function checkForUpdate(intervalHours = 6): Promise<UpdateStatus> {
  const current = currentVersion();
  const st = readState();
  const stale = Date.now() - st.lastCheckMs > intervalHours * 3600_000;
  let latest = st.latest;
  if (stale) {
    const fetched = await fetchLatest();
    if (fetched) {
      latest = fetched;
      writeState({ lastCheckMs: Date.now(), latest });
    } else {
      // record the attempt so a persistent failure doesn't retry on every call
      writeState({ ...st, lastCheckMs: Date.now() });
    }
  }
  return {
    current,
    latest,
    updateAvailable: Boolean(latest) && isNewer(current, latest),
    alreadyInstalled: Boolean(latest) && readState().installedLatest === latest,
  };
}

/** Remember that this release is on disk, so startup doesn't reinstall it every time. */
export function markInstalled(latest?: string): void {
  if (!latest) return;
  writeState({ ...readState(), installedLatest: latest });
}

/**
 * Install the latest release into APP_DIR. Runs npm in a directory we own, so no
 * shared npx cache is involved and the next launch always gets this copy.
 */
export function installLatest(timeoutMs = 300_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    try {
      mkdirSync(APP_DIR, { recursive: true });
      // a bare package.json keeps npm from walking up and touching the user's projects
      const pkg = join(APP_DIR, "package.json");
      if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: "ado-eod-host", private: true }, null, 2) + "\n");
    } catch (e: any) {
      return resolve({ ok: false, output: `could not prepare ${APP_DIR}: ${e.message}` });
    }
    execFile(
      process.execPath,
      [npmCli(), "install", "--no-audit", "--no-fund", "--silent", `github:${REPO}`],
      { cwd: APP_DIR, timeout: timeoutMs, env: { ...process.env, npm_config_yes: "true" } },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim().slice(0, 1500);
        resolve({ ok: !err && existsSync(managedCli()), output: output || (err ? String(err.message) : "") });
      },
    );
  });
}

/** npm's own JS entry point — invoking it through process.execPath avoids PATH problems. */
function npmCli(): string {
  const dir = dirname(process.execPath);
  for (const c of [
    join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
  ]) {
    if (existsSync(c)) return c;
  }
  return join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
}
