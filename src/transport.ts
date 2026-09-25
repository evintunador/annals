import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { git } from "./git.js";
import { incomingRef, notesRef, type Ledger, type NamespaceConfig } from "./ledger.js";
import { type AnnalsConfig } from "./redact/config.js";

const execFileP = promisify(execFile);

/** Env var that suppresses the pre-push hook while annals itself pushes. */
export function internalEnvVar(ns: NamespaceConfig): string {
  return ns.internalEnvName;
}

/**
 * Staging ref for events arriving from a remote. `git fetch` lands the
 * remote's ledger ref here (via the refspec ensureTransport configures);
 * absorbIncoming() folds it into the local ref lazily at read time. The
 * local ref is never force-overwritten — absorption is always the
 * cat_sort_uniq union.
 */
function fetchRefspec(ns: NamespaceConfig): string {
  return `+${notesRef(ns)}:${incomingRef(ns)}`;
}

function hookMarker(ns: NamespaceConfig): string {
  return `${ns.name} pre-push`;
}

export async function ensureMergeConfig(repo: Ledger): Promise<void> {
  const key = `notes.${repo.ns.name}.mergeStrategy`;
  const current = (await git(["config", "--get", key], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (current !== "cat_sort_uniq") {
    await git(["config", key, "cat_sort_uniq"], { cwd: repo.root });
  }
}

/**
 * The command hook scripts should run. Prefers the namespace's exact
 * installation (absolute node + cli script — immune to PATH differences),
 * with a PATH fallback on `ns.cliName` baked into the script itself for
 * when that installation moves.
 */
function hookInvocation(ns: NamespaceConfig): { node: string; cli: string } | null {
  return ns.hookInvocation ?? null;
}

/**
 * The block this namespace owns inside `pre-push`, delimited by HOOK_MARKER so it can
 * be recognized, upgraded, and removed without touching the rest of the file.
 *
 * The hook is fed git's pre-push stdin — one `<local ref> <local sha> <remote
 * ref> <remote sha>` line per ref being pushed — so the ledger push can be
 * scoped to the refs actually being pushed rather than to whatever happens to
 * be checked out. Before 0.15.0 this was `</dev/null` and the scope fell back
 * to `HEAD`, which meant `git push origin some-other-branch` shared nothing of
 * that branch.
 *
 * Consuming that stdin has a cost worth being explicit about: a `pre-push`
 * script's stdin can only be read once, so anything chained *after* this
 * block finds it exhausted. In practice that is nearly always fine, because
 * `installHook` appends this block to the end of an existing hook — an
 * existing script runs, and reads stdin, before this block does. When it
 * does read stdin first, this block's `$(cat)` comes back empty and the
 * scope falls back to `HEAD`, which is the pre-0.15.0 behavior rather than a
 * failure. Only hand-editing content in after this block loses the ref list,
 * and restoring it would mean spilling stdin to a temp file and `exec`-ing it
 * back onto fd 0 — more machinery in every user's hook than that case earns.
 */
function hookBlock(ns: NamespaceConfig): string {
  const inv = hookInvocation(ns);
  const guard = internalEnvVar(ns);
  const exact = inv
    ? [
        `  if [ -x "${inv.node}" ] && [ -e "${inv.cli}" ]; then`,
        `    printf '%s\\n' "$_annals_refs" | "${inv.node}" "${inv.cli}" transport-push "$1" || exit $?`,
        `  elif command -v ${ns.cliName} >/dev/null 2>&1; then`,
      ]
    : [`  if command -v ${ns.cliName} >/dev/null 2>&1; then`];
  return [
    `# >>> ${hookMarker(ns)} (added by ${ns.cliName}) >>>`,
    `# Shares this repo's ${ns.name} records (${notesRef(ns)}) when you push.`,
    `# Scoped to the refs being pushed, read from git's pre-push stdin.`,
    `# Delete this block to disable, or set {"transport": {"hook": false}} in`,
    `# ${ns.configFile} / ~/.config/${ns.userConfigDir}/config.json.`,
    `if [ -z "$${guard}" ]; then`,
    `  _annals_refs=$(cat)`,
    ...exact,
    `    printf '%s\\n' "$_annals_refs" | ${ns.cliName} transport-push "$1" || exit $?`,
    `  fi`,
    `  # Note: a pre-push script's stdin can only be read once, so anything`,
    `  # chained after this block will not see the ref list.`,
    `fi`,
    `# <<< ${hookMarker(ns)} <<<`,
  ].join("\n");
}
/**
 * Replace an already-installed namespace block with the current one.
 *
 * Without this an existing install keeps whatever block it was created with
 * forever — `installHook` used to return "present" on any file containing the
 * marker — so a behavior change in the hook itself (the stdin plumbing above)
 * would only ever reach fresh repos. Only the marked region is touched;
 * anything the user wrote around it is preserved byte for byte.
 */
function replaceHookBlock(ns: NamespaceConfig, existing: string, block: string): string | null {
  const start = existing.indexOf(`# >>> ${hookMarker(ns)}`);
  const endMarker = `# <<< ${hookMarker(ns)} <<<`;
  const endIdx = existing.indexOf(endMarker, start);
  if (start === -1 || endIdx === -1) return null;
  const end = endIdx + endMarker.length;
  const current = existing.slice(start, end);
  if (current === block) return null; // already current
  return existing.slice(0, start) + block + existing.slice(end);
}

/** Warnings that should print once per repo, not on every capture. */
async function warnOnce(repo: Ledger, key: string, message: string): Promise<void> {
  const stateDir = join(repo.commonDir, repo.ns.stateDirName);
  const path = join(stateDir, "transport-warnings.json");
  let warned: string[] = [];
  try {
    warned = JSON.parse(await readFile(path, "utf8")) as string[];
  } catch {
    // first warning, or unreadable state — state is rebuildable
  }
  if (warned.includes(key)) return;
  process.stderr.write(message);
  await mkdir(stateDir, { recursive: true });
  await writeFile(path, JSON.stringify([...warned, key]) + "\n");
}

export interface TransportSetup {
  hook:
    | "installed"
    | "present"
    | "upgraded"
    | "appended"
    | "skipped-config"
    | "skipped-hookspath"
    | "skipped-foreign";
  refspec: "added" | "present" | "skipped-config" | "no-remote";
}

/**
 * Transport is default-on but must cost the user nothing to get: the first
 * capture in a repo wires it up. Installs the pre-push hook (chain-safe:
 * appends to an existing shell hook, backs off with a one-time warning when
 * core.hooksPath or a non-shell hook owns the file) and adds the fetch
 * refspec that stages the remote's ledger ref on normal `git fetch`.
 * Runs on every append — each check is a cheap stat/config read — so a
 * remote added later still gets wired. Never throws: this runs inside
 * capture, which must never fail a user's session.
 */
export async function ensureTransport(
  repo: Ledger,
  config: AnnalsConfig,
): Promise<TransportSetup | null> {
  try {
    return {
      hook: await ensurePrePushHook(repo, config),
      refspec: await ensureFetchRefspec(repo, config),
    };
  } catch {
    return null;
  }
}

async function ensurePrePushHook(
  repo: Ledger,
  config: AnnalsConfig,
): Promise<TransportSetup["hook"]> {
  if (config.transport?.hook === false) return "skipped-config";

  const hooksPath = (await git(["config", "--get", "core.hooksPath"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (hooksPath) {
    await warnOnce(
      repo,
      "hookspath",
      `${repo.ns.cliName}: core.hooksPath is set (${hooksPath}), so the pre-push hook was not ` +
        `installed. To share records on push, add\n` +
        `  ${repo.ns.cliName} transport-push "$1"\n` +
        `to that pre-push hook, or run \`${repo.ns.cliName} sync\` manually.\n`,
    );
    return "skipped-hookspath";
  }

  // The common dir, never this worktree's own git dir: git resolves hooks
  // relative to `$GIT_COMMON_DIR`, so a pre-push script written under
  // `.git/worktrees/<name>/hooks/` is simply never executed. Installing it
  // there would leave a repo whose first capture happened inside a worktree
  // with a hook that looks installed and silently never runs.
  const hookPath = join(repo.commonDir, "hooks", "pre-push");
  if (!existsSync(hookPath)) {
    await mkdir(join(repo.commonDir, "hooks"), { recursive: true });
    await writeFile(hookPath, `#!/bin/sh\n${hookBlock(repo.ns)}\n`);
    await chmod(hookPath, 0o755);
    return "installed";
  }

  const existing = await readFile(hookPath, "utf8");
  if (existing.includes(hookMarker(repo.ns))) {
    const upgraded = replaceHookBlock(repo.ns, existing, hookBlock(repo.ns));
    if (upgraded === null) return "present";
    await writeFile(hookPath, upgraded);
    await chmod(hookPath, 0o755);
    return "upgraded";
  }

  const shebang = existing.split("\n", 1)[0] ?? "";
  if (!/^#!.*\b(sh|bash|zsh|dash|ksh)\b/.test(shebang)) {
    await warnOnce(
      repo,
      "foreign-hook",
      `${repo.ns.cliName}: this repo's pre-push hook is not a shell script, so the hook was not ` +
        `chained onto it. Run \`${repo.ns.cliName} sync\` to share records manually.\n`,
    );
    return "skipped-foreign";
  }

  await writeFile(hookPath, existing.replace(/\n?$/, "\n") + "\n" + hookBlock(repo.ns) + "\n");
  await chmod(hookPath, 0o755);
  return "appended";
}

async function ensureFetchRefspec(
  repo: Ledger,
  config: AnnalsConfig,
): Promise<TransportSetup["refspec"]> {
  if (config.transport?.fetchRefspec === false) return "skipped-config";

  const originUrl = (await git(["remote", "get-url", "origin"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (!originUrl) return "no-remote";

  const fetchSpecs = await git(["config", "--get-all", "remote.origin.fetch"], {
    cwd: repo.root,
    allowFailure: true,
  });
  if (fetchSpecs.includes(incomingRef(repo.ns))) return "present";

  await git(["config", "--add", "remote.origin.fetch", fetchRefspec(repo.ns)], { cwd: repo.root });
  return "added";
}

/**
 * Fold the staged incoming ref (populated by `git fetch` via the refspec)
 * into the local ledger ref — the lazy, read-time half of transport. The
 * merge is the same cat_sort_uniq union sync() uses, so absorbing can only
 * add events. Returns true when new remote state was absorbed. Never
 * throws: a concurrent notes merge just means the next read tries again.
 */
export async function absorbIncoming(repo: Ledger): Promise<boolean> {
  const incoming = (await git(["rev-parse", "--verify", "--quiet", incomingRef(repo.ns)], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (!incoming) return false;

  const local = (await git(["rev-parse", "--verify", "--quiet", notesRef(repo.ns)], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (local === incoming) {
    await git(["update-ref", "-d", incomingRef(repo.ns)], { cwd: repo.root, allowFailure: true });
    return false;
  }

  try {
    await ensureMergeConfig(repo);
    if (!local) {
      await git(["update-ref", notesRef(repo.ns), incoming], { cwd: repo.root });
    } else {
      await git(["notes", "--ref", repo.ns.name, "merge", "-s", "cat_sort_uniq", incomingRef(repo.ns)], {
        cwd: repo.root,
      });
    }
  } catch {
    return false;
  }
  await git(["update-ref", "-d", incomingRef(repo.ns)], { cwd: repo.root, allowFailure: true });
  return true;
}

/**
 * True when git can produce an explicit author identity (config or env —
 * never a hostname guess; see gitUserIdentity). Used by installers
 * to warn that captured human turns would be unattributed.
 */
export async function hasAuthorIdentity(): Promise<boolean> {
  try {
    await execFileP("git", ["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"]);
    return true;
  } catch {
    return false;
  }
}
