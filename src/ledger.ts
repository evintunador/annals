import { fileURLToPath } from "node:url";
import type { RepoInfo } from "./git.js";

/**
 * A namespace scopes everything annals touches in a repo: the notes ref the
 * records live under, the staging ref fetches land in, the state directory
 * under `.git`, the config files, and the CLI the pre-push hook invokes.
 *
 * Producers that own a vocabulary and want an independently-pushable,
 * independently-wipeable ref open their own namespace. Producers extending
 * an existing vocabulary (the way turnbridge writes `continuation` events
 * into cledger's conversations) write into that vocabulary's namespace
 * through its owner's API instead.
 */
export interface NamespaceConfig {
  /** Namespace name. Records live at `refs/notes/<name>`. */
  name: string;
  /** Name of the staging ref fetches land in, under refs/notes/. Defaults
   * to `<name>-incoming`; overridable so a namespace that predates annals
   * can keep the refspec already installed in existing repos. */
  incomingName: string;
  /** Directory under the repo's common git dir for local state (pending
   * events, allowlist, known-secrets). Defaults to `name`. */
  stateDirName: string;
  /** Per-repo config filename at the repo root, e.g. ".annals.json". */
  configFile: string;
  /** Directory under ~/.config for user-global config and allowlist. */
  userConfigDir: string;
  /** CLI name used in human-facing messages and as the pre-push hook's PATH
   * fallback. The named CLI must expose a `transport-push` subcommand that
   * reads git's pre-push ref lines on stdin. */
  cliName: string;
  /** Exact interpreter + script the pre-push hook should invoke, immune to
   * PATH differences. Omit to rely on the PATH fallback alone. */
  hookInvocation?: { node: string; cli: string };
}

/**
 * Everything an annals operation needs: the repo, plus which namespace of it
 * to operate on. Extends RepoInfo so plain git helpers accept it unchanged.
 */
export interface Ledger extends RepoInfo {
  ns: NamespaceConfig;
}

export const DEFAULT_NAMESPACE = "annals";

export function resolveNamespace(opts: Partial<NamespaceConfig> = {}): NamespaceConfig {
  const name = opts.name ?? DEFAULT_NAMESPACE;
  return {
    name,
    incomingName: opts.incomingName ?? `${name}-incoming`,
    stateDirName: opts.stateDirName ?? name,
    configFile: opts.configFile ?? `.${name}.json`,
    userConfigDir: opts.userConfigDir ?? name,
    cliName: opts.cliName ?? name,
    // Only the default namespace gets this package's own CLI as the hook
    // entrypoint: it operates on the default namespace alone, so pointing a
    // custom namespace's hook at it would push the wrong ref. Custom
    // namespaces either pass their owner's CLI or rely on the PATH fallback.
    ...(opts.hookInvocation
      ? { hookInvocation: opts.hookInvocation }
      : name === DEFAULT_NAMESPACE
        ? {
            hookInvocation: {
              node: process.execPath,
              cli: fileURLToPath(new URL("./cli.js", import.meta.url)),
            },
          }
        : {}),
  };
}

export function openLedger(repo: RepoInfo, opts: Partial<NamespaceConfig> = {}): Ledger {
  return { ...repo, ns: resolveNamespace(opts) };
}

export function notesRef(ns: NamespaceConfig): string {
  return `refs/notes/${ns.name}`;
}

/** Staging ref where the fetch refspec lands the remote's records. */
export function incomingRef(ns: NamespaceConfig): string {
  return `refs/notes/${ns.incomingName}`;
}
