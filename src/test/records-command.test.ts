import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Ledger } from "../ledger.js";
import { runRecordsCommand, type RecordsCommandOutput } from "../records-command.js";
import { cleanupRepo, makeTempRepo } from "./helpers.js";

function input(text = "", isTTY = false) {
  return {
    isTTY,
    async *[Symbol.asyncIterator]() {
      if (text) yield text;
    },
  };
}

function output(isTTY = false): RecordsCommandOutput & { text: string } {
  return {
    text: "",
    isTTY,
    write(chunk: string) {
      this.text += chunk;
    },
  };
}

function humanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(CLAUDECODE|CLAUDE_CODE|CODEX_|OPENCODE|GEMINI_CLI|QWEN_CODE|QWEN_CLI)/.test(name),
    ),
  );
}

test("records dispatcher is process-independent and uses the canonical downstream command name", async () => {
  const repo = await makeTempRepo();
  try {
    const stdout = output();
    const stderr = output();
    const code = await runRecordsCommand({
      ledger: repo,
      argv: ["help"],
      stdin: input(),
      stdout,
      stderr,
      env: {},
    });
    assert.equal(code, 0);
    assert.match(stdout.text, /^usage: annals records <command>/);
    assert.equal(stderr.text, "");
  } finally {
    await cleanupRepo(repo);
  }
});

test("human-only records commands refuse an agent session before touching a terminal", async () => {
  const repo = await makeTempRepo();
  try {
    const stdout = output();
    const stderr = output();
    const code = await runRecordsCommand({
      ledger: repo,
      argv: ["review"],
      stdin: input(),
      stdout,
      stderr,
      env: { CODEX_SANDBOX: "1" },
      commandName: "example records",
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /example records review refuses inside an agent session/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("boolean flags reject misleading =false values", async () => {
  const repo = await makeTempRepo();
  try {
    for (const argv of [
      ["sync", "--no-scan=false"],
      ["inspect", "--output", "report", "--reveal=false"],
      ["reanchor", "--apply=false"],
    ]) {
      const stderr = output();
      const code = await runRecordsCommand({
        ledger: repo,
        argv,
        stdin: input(),
        stdout: output(),
        stderr,
        env: {},
      });
      assert.equal(code, 2);
      assert.match(stderr.text, /does not accept a value/);
    }
  } finally {
    await cleanupRepo(repo);
  }
});

test("value options never consume a following flag", async () => {
  const repo = await makeTempRepo();
  try {
    for (const argv of [
      ["inspect", "--output", "--reveal"],
      ["redact", "event", "--pattern", "--all"],
    ]) {
      const stderr = output();
      const code = await runRecordsCommand({
        ledger: repo,
        argv,
        stdin: input(),
        stdout: output(),
        stderr,
        env: {},
      });
      assert.equal(code, 2);
      assert.match(stderr.text, /requires a value/);
    }
  } finally {
    await cleanupRepo(repo);
  }
});

test("sync --no-scan refuses an agent session before bypassing the gate", async () => {
  const repo = await makeTempRepo();
  try {
    const stderr = output();
    const code = await runRecordsCommand({
      ledger: repo,
      argv: ["sync", "--push-only", "--no-scan"],
      stdin: input(),
      stdout: output(),
      stderr,
      env: { CODEX_SANDBOX: "1" },
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /refuses inside an agent session/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("inspect overwrite repairs permissions before writing", async () => {
  const repo = await makeTempRepo();
  try {
    const report = join(repo.root, "report.txt");
    await writeFile(report, "old");
    await chmod(report, 0o644);
    const stderr = output();
    const code = await runRecordsCommand({
      ledger: repo,
      argv: ["inspect", "--output", report, "--overwrite"],
      stdin: input(),
      stdout: output(),
      stderr,
      env: humanEnv(),
    });
    assert.equal(code, 0, stderr.text);
    assert.equal((await stat(report)).mode & 0o777, 0o600);
    assert.equal(await readFile(report, "utf8"), "No outstanding findings.\n");
  } finally {
    await cleanupRepo(repo);
  }
});

test("manual reanchor refuses agent attribution", async () => {
  const repo = await makeTempRepo();
  try {
    const stderr = output();
    const code = await runRecordsCommand({
      ledger: repo,
      argv: ["reanchor", "manual", "old", "--onto", "new"],
      stdin: input(),
      stdout: output(),
      stderr,
      env: { CODEX_SANDBOX: "1" },
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /refuses inside an agent session/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("transport-push keeps unexpected preflight failures fail-open", async () => {
  const repo = await makeTempRepo();
  try {
    const ns = {
      ...repo.ns,
      get internalEnvName(): string {
        throw new Error("simulated preflight failure");
      },
    };
    const stderr = output();
    const code = await runRecordsCommand({
      ledger: { ...repo, ns } as Ledger,
      argv: ["transport-push"],
      stdin: input(),
      stdout: output(),
      stderr,
      env: {},
      commandName: "example records",
    });
    assert.equal(code, 0);
    assert.match(stderr.text, /push continues/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("dispatcher routes lower-level diagnostics and isolates its environment", async () => {
  const repo = await makeTempRepo();
  try {
    await writeFile(join(repo.root, ".annals.json"), "{invalid");
    const report = join(repo.root, "report.txt");
    const stderr = output();
    const priorGuard = process.env.ANNALS_INTERNAL;
    const code = await runRecordsCommand({
      ledger: repo,
      argv: ["inspect", "--output", report],
      stdin: input(),
      stdout: output(),
      stderr,
      env: humanEnv(),
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stderr.text, /ignoring .*\.annals\.json/);
    assert.equal(process.env.ANNALS_INTERNAL, priorGuard);
  } finally {
    await cleanupRepo(repo);
  }
});

test("records dispatcher rejects ambiguous sync modes without exiting the process", async () => {
  const repo = await makeTempRepo();
  try {
    const stderr = output();
    const code = await runRecordsCommand({
      ledger: repo,
      argv: ["sync", "--fetch-only", "--push-only"],
      stdin: input(),
      stdout: output(),
      stderr,
      env: {},
      commandName: "example records",
    });
    assert.equal(code, 2);
    assert.match(stderr.text, /only one of --fetch-only and --push-only/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("records help is available without repository discovery through the bundled CLI", () => {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "help"], {
    cwd: process.env.HOME,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^usage: annals <command>/);
});

test("bundled CLI preserves canonical records spelling in help", () => {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "records", "help"], {
    cwd: process.env.HOME,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^usage: annals records <command>/);
});
