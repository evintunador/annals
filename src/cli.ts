#!/usr/bin/env node
import { findRepo, type RepoInfo } from "./git.js";
import { openLedger } from "./ledger.js";
import {
  createNamespaceProfile,
  listNamespaceProfiles,
  loadNamespaceProfile,
  profilePath,
  removeNamespaceProfile,
  saveNamespaceProfile,
  type NamespaceProfile,
  type ProfileScope,
} from "./profiles.js";
import { recordsCommandUsage, runRecordsCommand } from "./records-command.js";

function takeOption(args: string[], name: string): string | undefined {
  const direct = args.indexOf(`--${name}`);
  const equal = args.findIndex((arg) => arg.startsWith(`--${name}=`));
  if (direct >= 0 && equal >= 0) throw new Error(`duplicate option --${name}`);
  if (equal >= 0) {
    const value = args.splice(equal, 1)[0]!.slice(name.length + 3);
    if (!value) throw new Error(`--${name} requires a value`);
    return value;
  }
  if (direct < 0) return undefined;
  const value = args[direct + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  args.splice(direct, 2);
  return value;
}

function takeBoolean(args: string[], name: string): boolean {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

async function requireRepo(): Promise<RepoInfo> {
  const repo = await findRepo(process.cwd());
  if (!repo) throw new Error("not inside a git repository");
  return repo;
}

function profileUsage(): string {
  return [
    "usage:",
    "  annals profile list",
    "  annals profile show NAME",
    "  annals profile add NAME --namespace NAME [namespace options] [--local]",
    "  annals profile remove NAME [--local]",
    "",
    "namespace options:",
    "  --incoming NAME --internal-env NAME --state-dir NAME",
    "  --config-file NAME --user-config-dir NAME --cli-name NAME",
  ].join("\n");
}

async function profileCommand(args: string[]): Promise<number> {
  const subcommand = args.shift();
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    process.stdout.write(`${profileUsage()}\n`);
    return 0;
  }
  const local = takeBoolean(args, "local");
  const scope: ProfileScope = local ? "local" : "global";
  const repo = await findRepo(process.cwd());
  if (local && !repo) throw new Error("--local requires a git repository");

  if (subcommand === "list") {
    if (local) throw new Error("--local is only valid with profile add or profile remove");
    if (args.length > 0) throw new Error("profile list accepts no arguments");
    const profiles = await listNamespaceProfiles(repo);
    for (const name of Object.keys(profiles).sort()) process.stdout.write(`${name}\n`);
    return 0;
  }
  const name = args.shift();
  if (!name) throw new Error(`profile ${subcommand} requires a name`);

  if (subcommand === "show") {
    if (local) throw new Error("--local is only valid with profile add or profile remove");
    if (args.length > 0) throw new Error("profile show accepts only a name");
    process.stdout.write(`${JSON.stringify(await loadNamespaceProfile(repo, name), null, 2)}\n`);
    return 0;
  }
  if (subcommand === "remove") {
    if (args.length > 0) throw new Error("profile remove accepts only a name and optional --local");
    const removed = await removeNamespaceProfile(repo, name, scope);
    if (!removed) throw new Error(`profile "${name}" does not exist in ${scope} scope`);
    process.stderr.write(`annals: removed ${scope} profile "${name}"\n`);
    return 0;
  }
  if (subcommand === "add") {
    const namespace = takeOption(args, "namespace");
    if (!namespace) throw new Error("profile add requires --namespace NAME");
    const partial: Partial<NamespaceProfile> & { name: string } = { name: namespace };
    const options: Array<[string, keyof NamespaceProfile]> = [
      ["incoming", "incomingName"],
      ["internal-env", "internalEnvName"],
      ["state-dir", "stateDirName"],
      ["config-file", "configFile"],
      ["user-config-dir", "userConfigDir"],
      ["cli-name", "cliName"],
    ];
    for (const [flag, field] of options) {
      const value = takeOption(args, flag);
      if (value !== undefined) partial[field] = value;
    }
    if (args.length > 0) throw new Error(`unknown profile option ${args[0]}`);
    const profile = createNamespaceProfile(partial);
    await saveNamespaceProfile(repo, name, profile, scope);
    process.stderr.write(
      `annals: saved ${scope} profile "${name}" at ${profilePath(repo, scope)}\n`,
    );
    return 0;
  }
  throw new Error(`unknown profile command "${subcommand}"\n\n${profileUsage()}`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const profileName = takeOption(args, "profile");
  if (args[0] === "profile") {
    if (profileName) throw new Error("--profile cannot be combined with profile maintenance");
    return profileCommand(args.slice(1));
  }
  const canonical = args[0] === "records";
  if (canonical) args.shift();
  const commandName = canonical ? "annals records" : "annals";
  if (!profileName && (!args[0] || args[0] === "help" || args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(`${recordsCommandUsage(commandName)}\n`);
    return 0;
  }
  const repo = await requireRepo();
  const namespace = profileName ? await loadNamespaceProfile(repo, profileName) : undefined;
  const ledger = openLedger(repo, namespace);
  return runRecordsCommand({
    ledger,
    argv: args,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    commandName,
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`annals: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
