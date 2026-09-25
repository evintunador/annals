import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { Ledger } from "../ledger.js";
import { join } from "node:path";
import { rulesForTier, type RedactionRule } from "./rules.js";

export interface AnnalsConfig {
  /**
   * Master per-repo switch (default true). false turns appends off entirely
   * for this namespace: appendEvents becomes a no-op before any ledger
   * read/write happens. Existing recorded history remains readable; this only
   * stops new events from being written.
   */
  enabled?: boolean;
  redact?: {
    capture?: boolean;
    env?: boolean;
    /**
     * Opt-in (default false). When true, a redact workflow remembers
     * the exact values it scrubbed in a local, git-invisible store, and
     * capture-time redaction exact-matches them out of every future event.
     * Off means the store is never read or created. See redact/known-secrets.ts.
     */
    knownSecrets?: boolean;
    patterns?: { id?: string; pattern: string }[];
  };
  scan?: {
    tier?: "standard" | "paranoid" | "off";
    /**
     * Fingerprints of known false positives, matching the values an allow
     * workflow records. Unlike allowlist files under `.git/`, these travel
     * with configuration: a repo can commit recurring false positives so
     * every clone and worktree inherits them, and the
     * global config can carry personal ones. Fingerprints are truncated
     * sha256 of the matched span — of text a human judged to NOT be a
     * secret — so committing them discloses nothing.
     */
    allowFingerprints?: string[];
  };
  limits?: {
    /**
     * Warn on stderr when a single serialized event exceeds this many bytes
     * (default 5_000_000). Notes replicate to every clone that fetches the
     * ref, so events this size deserve a look — the append still succeeds:
     * capture must never fail on size alone.
     */
    warnEventBytes?: number;
    /**
     * Refuse an event larger than this many bytes (default: off). Opt-in,
     * for producers that would rather fail loudly than replicate a blob —
     * a derived layer, say. Never enable on a capture path that must not
     * drop records.
     */
    maxEventBytes?: number;
  };
  transport?: {
    /** Install/run the pre-push hook that shares the ledger ref (default true). */
    hook?: boolean;
    /**
     * When the pre-push scan finds a potential secret: false (default)
     * holds back only the ledger push and lets the code push proceed;
     * true aborts the entire git push.
     */
    strict?: boolean;
    /** Add the fetch refspec that stages the remote's ledger ref (default true). */
    fetchRefspec?: boolean;
  };
  reanchor?: {
    /**
     * Auto-append re_anchor mappings for exact (tree / patch-id) matches
     * when a fetch shows the remote target branch rewrote local commits
     * that carry conversations (default true). Fuzzy matches are never
     * auto-applied regardless of this flag; producer CLIs confirm those.
     */
    auto?: boolean;
    /**
     * Query the forge (via the user's own CLI session, e.g. `gh`) for PR
     * metadata when ranking candidates in an explicit re-anchor workflow
     * (default true). Never queried in the
     * auto read path, which stays offline regardless.
     */
    forge?: boolean;
  };
}

/** Names that routinely hold long non-secret values; excluded from env scrubbing. */
const NON_SECRET_ENV_NAME = /^(?:PATH|HOME|PWD|OLDPWD|SHELL|TERM.*|USER|LOGNAME|LANG|LC_.*|EDITOR|VISUAL|PAGER|TMPDIR|DISPLAY|SSH_AUTH_SOCK|XDG_.*)$/;

/**
 * A config file that exists but cannot be read is reported, never swallowed.
 *
 * Absent config is the normal case and stays silent. But a *present* file
 * that fails to parse used to be indistinguishable from one that isn't
 * there — so a single trailing comma in a namespace config silently reverted
 * every setting to its default, including the opt-in redaction layers whose
 * entire purpose is being switched on. Failing open is the right behavior
 * (capture must never break a session over config), but failing open
 * *silently* means the user believes protections are active when they are
 * not. Warn and continue.
 */
async function readJsonConfig(cliName: string, path: string): Promise<AnnalsConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null; // absent (or unreadable) — the ordinary case, stay quiet
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AnnalsConfig;
    }
    process.stderr.write(
      `${cliName}: ignoring ${path} — expected a JSON object, got ` +
        `${Array.isArray(parsed) ? "an array" : typeof parsed}. All settings in it are ` +
        `inactive; defaults are in effect.\n`,
    );
    return null;
  } catch (err) {
    process.stderr.write(
      `${cliName}: ignoring ${path} — invalid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `All settings in it are inactive; defaults are in effect.\n`,
    );
    return null;
  }
}

/**
 * Merge one top-level section key-by-key: any key the repo config sets wins,
 * any key it leaves out keeps the global value. Before 0.21.0 the repo
 * section replaced the global one wholesale, which failed open: a repo
 * config file that set only `redact.capture` silently reverted a
 * globally-enabled `redact.knownSecrets` — the user believed a protection
 * was on when the mere presence of an unrelated key had turned it off.
 *
 * One exception to "repo wins": `allowFingerprints` arrays are unioned, not
 * replaced. The allowlist is accumulative by nature — a fingerprint either
 * config trusts is trusted — and replacing would make adding a repo-local
 * entry silently drop every personal one.
 */
function mergeSection<T extends object>(
  base: T | undefined,
  override: T | undefined,
): T | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>), ...(override as Record<string, unknown>) };
  const baseAllow = (base as { allowFingerprints?: unknown }).allowFingerprints;
  const overrideAllow = (override as { allowFingerprints?: unknown }).allowFingerprints;
  if (Array.isArray(baseAllow) && Array.isArray(overrideAllow)) {
    merged["allowFingerprints"] = [...new Set([...baseAllow, ...overrideAllow])];
  }
  return merged as T;
}

/**
 * Merges ~/.config/<ns>/config.json then <repoRoot>/<ns config file>.
 * Repo wins, key-by-key within each top-level section ("redact", "scan",
 * "transport", "reanchor") — see mergeSection for why not per-section.
 */
export async function loadConfig(repo: Ledger): Promise<AnnalsConfig> {
  const userPath = join(homedir(), ".config", repo.ns.userConfigDir, "config.json");
  const repoPath = join(repo.root, repo.ns.configFile);
  const [userConfig, repoConfig] = await Promise.all([
    readJsonConfig(repo.ns.cliName, userPath),
    readJsonConfig(repo.ns.cliName, repoPath),
  ]);
  const base = userConfig ?? {};
  const override = repoConfig ?? {};
  const enabled = override.enabled ?? base.enabled;
  const redact = mergeSection(base.redact, override.redact);
  const scan = mergeSection(base.scan, override.scan);
  const transport = mergeSection(base.transport, override.transport);
  const reanchor = mergeSection(base.reanchor, override.reanchor);
  const limits = mergeSection(base.limits, override.limits);
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(redact !== undefined ? { redact } : {}),
    ...(scan !== undefined ? { scan } : {}),
    ...(transport !== undefined ? { transport } : {}),
    ...(reanchor !== undefined ? { reanchor } : {}),
    ...(limits !== undefined ? { limits } : {}),
  };
}

/**
 * Capture-tier rules plus compiled user patterns from config. Invalid user
 * regexes are skipped silently (never throw — capture must never fail a
 * session). Returns [] when redact.capture is explicitly false.
 */
export function captureRules(config: AnnalsConfig): RedactionRule[] {
  if (config.redact?.capture === false) return [];
  const rules = rulesForTier("capture");
  const userPatterns = config.redact?.patterns ?? [];
  userPatterns.forEach((p, i) => {
    if (!p || !p.pattern) return;
    try {
      const pattern = new RegExp(p.pattern, "g");
      rules.push({
        id: p.id ?? `user-pattern-${i}`,
        tier: "capture",
        description: "User-configured capture pattern",
        pattern,
      });
    } catch {
      // Invalid regex: skip silently.
    }
  });
  return rules;
}

async function parseDotEnv(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const values: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value) values.push(value);
  }
  return values;
}

/**
 * Exact values to scrub for opt-in env masking (layer C): process.env
 * values that look secret-shaped, plus values parsed from <repoRoot>/.env.
 * Only call this when config.redact?.env === true.
 */
export async function collectEnvValues(repoRoot: string): Promise<string[]> {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (NON_SECRET_ENV_NAME.test(name)) continue;
    if (value.startsWith("/")) continue;
    values.add(value);
  }
  const dotEnvValues = await parseDotEnv(join(repoRoot, ".env"));
  for (const value of dotEnvValues) {
    if (value.length >= 8 && !value.startsWith("/")) values.add(value);
  }
  return [...values];
}
