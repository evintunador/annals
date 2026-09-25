import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Ledger } from "./ledger.js";
import { loadConfig } from "./redact/config.js";
import {
  addToAllowlist,
  filterFindings,
  inAgentSession,
  loadAllowlist,
  renderFinding,
  scanEvents,
} from "./redact/scan.js";
import { runReview, type ReviewInput, type ReviewOutput } from "./review.js";
import { runWithRuntimeContext } from "./runtime.js";
import {
  manualReAnchor,
  parsePrePushRefs,
  readEvents,
  redactEvent,
  runReAnchor,
  ScanBlockedError,
  sync,
  transportPush,
} from "./store.js";

export interface RecordsCommandInput extends AsyncIterable<Uint8Array | string> {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume?(): void;
  pause?(): void;
  on?(event: string | symbol, listener: (...args: any[]) => void): unknown;
  off?(event: string | symbol, listener: (...args: any[]) => void): unknown;
}

export interface RecordsCommandOutput {
  write(text: string): unknown;
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  on?(event: string | symbol, listener: (...args: any[]) => void): unknown;
  off?(event: string | symbol, listener: (...args: any[]) => void): unknown;
}

export interface RecordsCommandOptions {
  ledger: Ledger;
  argv: string[];
  stdin: RecordsCommandInput;
  stdout: RecordsCommandOutput;
  stderr: RecordsCommandOutput;
  /** Environment inherited by child processes and used by safety guards. */
  env?: NodeJS.ProcessEnv;
  /** Human-facing invocation prefix. Defaults to `<namespace CLI> records`. */
  commandName?: string;
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

class CommandUsageError extends Error {}

function badUsage(message: string): never {
  throw new CommandUsageError(message);
}

const VALUE_FLAGS = new Set(["context", "output", "pattern", "reason", "target", "tier", "onto"]);

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const name = arg.slice(2, equal < 0 ? undefined : equal);
    if (!name || flags.has(name)) badUsage(`invalid or duplicate option --${name}`);
    if (equal >= 0) {
      if (!VALUE_FLAGS.has(name)) badUsage(`--${name} does not accept a value`);
      flags.set(name, arg.slice(equal + 1));
    } else if (VALUE_FLAGS.has(name)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) badUsage(`--${name} requires a value`);
      flags.set(name, value);
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function assertFlags(parsed: ParsedArgs, allowed: string[]): void {
  const allow = new Set(allowed);
  for (const name of parsed.flags.keys()) {
    if (!allow.has(name)) badUsage(`unknown option --${name}`);
  }
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true || value.length === 0) badUsage(`--${name} requires a value`);
  return value;
}

function numberFlag(parsed: ParsedArgs, name: string, fallback: number): number {
  const raw = stringFlag(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    badUsage(`--${name} must be an integer from 0 to 10000`);
  }
  return value;
}

async function readInput(input: RecordsCommandInput): Promise<string> {
  let text = "";
  for await (const chunk of input) text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  return text;
}

function requireHuman(env: NodeJS.ProcessEnv, command: string): void {
  const marker = inAgentSession(env);
  if (marker) {
    throw new Error(
      `${command} refuses inside an agent session (${marker}); run it yourself in a plain terminal`,
    );
  }
}

async function writePrivateFile(path: string, body: string, overwrite: boolean): Promise<void> {
  const flags = overwrite
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  try {
    // chmod precedes truncate/write so an existing permissive file never
    // exposes newly written report content. O_NOFOLLOW rejects symlinks.
    await handle.chmod(0o600);
    await handle.truncate(0);
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
}

export function recordsCommandUsage(commandName: string): string {
  return [
    `usage: ${commandName} <command> [options]`,
    "",
    "commands:",
    "  sync [remote] [--fetch-only|--push-only] [--no-scan] [--paranoid] [--all] [--report]",
    "  review [--tier standard|paranoid] [--context N]",
    "  inspect --output FILE [--tier standard|paranoid] [--context N] [--reveal]",
    "  redact EVENT_ID (--pattern REGEX|--all) [--reason TEXT]",
    "  allow FINGERPRINT... [--global]",
    "  reanchor [--target REV] [--apply]",
    "  reanchor manual OLD_REV... --onto NEW_REV",
    "  transport-push [remote] [--report]",
  ].join("\n");
}

async function execute(options: RecordsCommandOptions): Promise<number> {
  const { ledger, stdin, stdout, stderr } = options;
  const env = options.env ?? process.env;
  const commandName = options.commandName ?? `${ledger.ns.cliName} records`;
  const [command, ...rest] = options.argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout.write(`${recordsCommandUsage(commandName)}\n`);
    return 0;
  }
  const parsed = parseArgs(rest);

  if (command === "sync") {
    assertFlags(parsed, ["all", "fetch-only", "no-scan", "paranoid", "push-only", "report"]);
    if (parsed.positional.length > 1) badUsage("sync accepts at most one remote");
    if (parsed.flags.has("fetch-only") && parsed.flags.has("push-only")) {
      badUsage("sync accepts only one of --fetch-only and --push-only");
    }
    const mode = parsed.flags.has("fetch-only")
      ? "fetch"
      : parsed.flags.has("push-only")
        ? "push"
        : "both";
    if (parsed.flags.has("no-scan") && mode !== "fetch") {
      requireHuman(env, `${commandName} sync --no-scan`);
    }
    const remote = parsed.positional[0] ?? "origin";
    const result = await sync(ledger, remote, mode, {
      skipScan: parsed.flags.has("no-scan"),
      paranoid: parsed.flags.has("paranoid"),
      reportFindings: parsed.flags.has("report"),
      ...(parsed.flags.has("all") ? { scope: null } : {}),
    });
    const pushed =
      mode === "fetch"
        ? "not pushed"
        : result.scopedAnchors === null
          ? "pushed (whole ledger)"
          : `pushed (${result.scopedAnchors} commit(s) in scope)`;
    stderr.write(
      `sync ${remote}: ${result.fetched ? "fetched+merged" : "nothing fetched"}, ${pushed}\n`,
    );
    return 0;
  }

  if (command === "transport-push") {
    assertFlags(parsed, ["report"]);
    if (parsed.positional.length > 1) badUsage("transport-push accepts at most one remote");
    let refs: string[] = [];
    if (stdin.isTTY !== true) {
      try {
        refs = parsePrePushRefs(await readInput(stdin));
      } catch {
        // A hook must not abort the user's code push because its stdin could
        // not be consumed. transportPush safely falls back to HEAD scope.
        refs = [];
      }
    }
    try {
      await transportPush(ledger, parsed.positional[0] ?? "origin", refs, {
        reportFindings: parsed.flags.has("report"),
      });
    } catch (err) {
      if (err instanceof ScanBlockedError) throw err;
      stderr.write(
        `${ledger.ns.cliName}: transport-push error (push continues): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return 0;
  }

  if (command === "review") {
    assertFlags(parsed, ["context", "tier"]);
    if (parsed.positional.length > 0) badUsage("review accepts no positional arguments");
    requireHuman(env, `${commandName} review`);
    if (
      stdin.isTTY !== true ||
      stdout.isTTY !== true ||
      !stdin.setRawMode ||
      !stdin.resume ||
      !stdin.pause ||
      !stdin.on ||
      !stdin.off ||
      !stdout.on ||
      !stdout.off
    ) {
      throw new Error("review requires an interactive terminal on stdin and stdout");
    }
    const config = await loadConfig(ledger);
    const requestedTier = stringFlag(parsed, "tier");
    if (requestedTier && requestedTier !== "standard" && requestedTier !== "paranoid") {
      badUsage("--tier must be standard or paranoid");
    }
    const tier: "standard" | "paranoid" =
      requestedTier === "paranoid" || config.scan?.tier === "paranoid" ? "paranoid" : "standard";
    const summary = await runReview(
      ledger,
      { tier, context: numberFlag(parsed, "context", 120), commandName },
      { stdin: stdin as ReviewInput, stdout: stdout as ReviewOutput },
    );
    stderr.write(
      `review: ${summary.allowed} allowed locally, ${summary.allowedGlobally} globally, ` +
        `${summary.redacted} redacted, ${summary.skipped} skipped, ${summary.errors.length} error(s)\n`,
    );
    return summary.errors.length === 0 ? 0 : 1;
  }

  if (command === "inspect") {
    assertFlags(parsed, ["context", "output", "overwrite", "reveal", "tier"]);
    if (parsed.positional.length > 0) badUsage("inspect accepts no positional arguments");
    requireHuman(env, `${commandName} inspect`);
    const output = stringFlag(parsed, "output");
    if (!output) badUsage("inspect requires --output FILE");
    const requestedTier = stringFlag(parsed, "tier");
    if (requestedTier && requestedTier !== "standard" && requestedTier !== "paranoid") {
      badUsage("--tier must be standard or paranoid");
    }
    const config = await loadConfig(ledger);
    const tier: "standard" | "paranoid" =
      requestedTier === "paranoid" || config.scan?.tier === "paranoid" ? "paranoid" : "standard";
    const events = await readEvents(ledger, { reachableFrom: null });
    const byId = new Map(events.map((event) => [event.id, event]));
    const findings = filterFindings(scanEvents(events, tier), await loadAllowlist(ledger, config));
    const body = findings
      .map((finding) => {
        const event = byId.get(finding.eventId);
        return event
          ? renderFinding(event, finding, {
              context: numberFlag(parsed, "context", 120),
              reveal: parsed.flags.has("reveal"),
            })
          : `event ${finding.eventId} is no longer present\n`;
      })
      .join("\n");
    await writePrivateFile(output, body || "No outstanding findings.\n", parsed.flags.has("overwrite"));
    stderr.write(`inspect: wrote ${findings.length} finding site(s) to ${output}\n`);
    return findings.length === 0 ? 0 : 1;
  }

  if (command === "redact") {
    assertFlags(parsed, ["all", "pattern", "reason"]);
    requireHuman(env, `${commandName} redact`);
    if (parsed.positional.length !== 1) badUsage("redact requires one event id prefix");
    const pattern = stringFlag(parsed, "pattern");
    const all = parsed.flags.has("all");
    if ((pattern !== undefined) === all) badUsage("redact requires exactly one of --pattern or --all");
    const reason = stringFlag(parsed, "reason");
    const result = await redactEvent(ledger, parsed.positional[0]!, {
      ...(pattern === undefined ? {} : { pattern }),
      ...(all ? { all: true } : {}),
      ...(reason === undefined ? {} : { reason }),
    });
    stderr.write(`redact: rewrote ${result.event.id.slice(0, 16)} and recorded an audit event\n`);
    return 0;
  }

  if (command === "allow") {
    assertFlags(parsed, ["global"]);
    requireHuman(env, `${commandName} allow`);
    if (parsed.positional.length === 0) badUsage("allow requires at least one fingerprint");
    for (const fingerprint of parsed.positional) {
      if (!/^[0-9a-f]{12}$/.test(fingerprint)) badUsage(`invalid fingerprint "${fingerprint}"`);
    }
    const scope = parsed.flags.has("global") ? "global" : "local";
    await addToAllowlist(ledger, parsed.positional, scope);
    stderr.write(`allow: added ${parsed.positional.length} fingerprint(s) to the ${scope} allowlist\n`);
    return 0;
  }

  if (command === "reanchor" || command === "re-anchor") {
    assertFlags(parsed, ["apply", "onto", "target"]);
    if (parsed.positional[0] === "manual") {
      requireHuman(env, `${commandName} reanchor manual`);
      const superseded = parsed.positional.slice(1);
      const onto = stringFlag(parsed, "onto");
      if (!onto || superseded.length === 0) {
        badUsage("reanchor manual requires OLD_REV... --onto NEW_REV");
      }
      const result = await manualReAnchor(ledger, superseded, onto);
      stderr.write(
        `reanchor: mapped ${result.superseded.length} commit(s) to ${result.successor.slice(0, 12)}` +
          `${result.event ? "" : " (already recorded)"}\n`,
      );
      return 0;
    }
    if (parsed.positional.length > 0) badUsage("reanchor accepts no positional arguments");
    const target = stringFlag(parsed, "target");
    const result = await runReAnchor(ledger, {
      apply: parsed.flags.has("apply"),
      ...(target === undefined ? {} : { target }),
    });
    stderr.write(
      `reanchor: ${result.detected.length} exact mapping(s), ${result.ambiguous.length} ambiguous, ` +
        `${result.unmatched.length} unmatched, ${result.applied.length} applied\n`,
    );
    return result.ambiguous.length === 0 ? 0 : 1;
  }

  badUsage(`unknown records command "${command}"\n\n${recordsCommandUsage(commandName)}`);
}

/** Run the standard records command set without reading or mutating global process I/O. */
export async function runRecordsCommand(options: RecordsCommandOptions): Promise<number> {
  const env = { ...(options.env ?? process.env) };
  return runWithRuntimeContext({ stderr: options.stderr, env }, async () => {
    try {
      return await execute({ ...options, env });
    } catch (err) {
      const commandName = options.commandName ?? `${options.ledger.ns.cliName} records`;
      options.stderr.write(`${commandName}: ${err instanceof Error ? err.message : String(err)}\n`);
      return err instanceof CommandUsageError ? 2 : 1;
    }
  });
}
