#!/usr/bin/env node
/**
 * Minimal CLI for the default `annals` namespace: the two commands transport
 * needs to exist (`transport-push` for the pre-push hook, `sync` for manual
 * use). Vocabulary owners (cledger, …) ship their own CLIs for their own
 * namespaces; this one exists so a bare `annals` install is self-contained.
 */
import { findRepo } from "./git.js";
import { openLedger } from "./ledger.js";
import { parsePrePushRefs, ScanBlockedError, sync, transportPush } from "./store.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function requireLedger() {
  const repo = await findRepo(process.cwd());
  if (!repo) {
    process.stderr.write("annals: not inside a git repository\n");
    process.exit(2);
  }
  return openLedger(repo);
}

async function cmdTransportPush(positional: string[], flags: Set<string>): Promise<void> {
  const repo = await findRepo(process.cwd());
  if (!repo) return; // a hook must never fail the user's push
  const ledger = openLedger(repo);
  const remote = positional[0] || "origin";
  // git's pre-push hook pipes the refs being pushed. Only read when stdin is
  // actually a pipe: a manual `annals transport-push` from a terminal would
  // otherwise block forever waiting on a human who has nothing to type.
  let revs: string[] = [];
  if (process.stdin.isTTY !== true) {
    try {
      revs = parsePrePushRefs(await readStdin());
    } catch {
      revs = []; // unreadable stdin must never fail the user's push
    }
  }
  try {
    await transportPush(ledger, remote, revs, { reportFindings: flags.has("report") });
  } catch (err) {
    if (err instanceof ScanBlockedError) {
      // transport.strict: nonzero exit makes git abort the entire push.
      process.stderr.write("annals: entire push blocked (transport.strict is enabled)\n");
      process.exit(1);
    }
    // Anything else is an annals bug or environment problem; the user's
    // code push must proceed regardless.
    process.stderr.write(
      `annals: transport-push error (push continues): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function cmdSync(positional: string[], flags: Set<string>): Promise<void> {
  const ledger = await requireLedger();
  const remote = positional[0] || "origin";
  const result = await sync(ledger, remote, "both", {
    skipScan: flags.has("no-scan"),
    reportFindings: flags.has("report"),
    ...(flags.has("all") ? { scope: null } : {}),
  });
  const pushed =
    result.scopedAnchors === null
      ? "pushed (whole ledger)"
      : `pushed (${result.scopedAnchors} commit(s) in scope)`;
  process.stderr.write(
    `sync ${remote}: ${result.fetched ? "fetched+merged" : "nothing fetched"}, ${pushed}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = new Set(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2)));
  const command = positional.shift();
  switch (command) {
    case "transport-push":
      return cmdTransportPush(positional, flags);
    case "sync":
      return cmdSync(positional, flags);
    default:
      process.stderr.write(
        "usage:\n" +
          "  annals sync [remote] [--no-scan] [--all] [--report]  fetch+push the annals notes ref\n" +
          "  annals transport-push [remote] [--report]           pre-push hook entrypoint\n" +
          "\n--report prints finding coordinates and fingerprints, never matched content.\n",
      );
      process.exit(command === undefined || command === "help" ? 0 : 2);
  }
}

main().catch((err) => {
  process.stderr.write(`annals: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
