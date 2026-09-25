import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git } from "../git.js";
import { scanEvents } from "../redact/scan.js";
import { appendEvents, readEvents } from "../store.js";
import {
  cleanupDir,
  cleanupRepo,
  draft,
  makeBareRepo,
  makeCommit,
  makeTempRepo,
} from "./helpers.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

test("CLI sync --report deliberately expands a blocked scan without changing its exit status", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    const secret = ["qZ8mK2", "pL7vN4wR"].join("");
    await appendEvents(repo, [draft({ content: { text: `password=${secret}` } })]);
    const [finding] = scanEvents(await readEvents(repo), "standard");
    assert.ok(finding);

    const concise = spawnSync(process.execPath, [CLI_PATH, "sync", "origin"], {
      cwd: repo.root,
      encoding: "utf8",
      env: process.env,
    });
    assert.strictEqual(concise.status, 1, "a blocked sync must exit nonzero");
    assert.match(concise.stderr, /sync origin --report/);
    assert.ok(!concise.stderr.includes(finding.fingerprint));
    assert.ok(!concise.stderr.includes(finding.eventId.slice(0, 16)));

    const detailed = spawnSync(process.execPath, [CLI_PATH, "sync", "origin", "--report"], {
      cwd: repo.root,
      encoding: "utf8",
      env: process.env,
    });
    assert.strictEqual(detailed.status, 1, "--report must not bypass the gate");
    assert.ok(detailed.stderr.includes(`[${finding.fingerprint}]`));
    assert.ok(detailed.stderr.includes(finding.eventId.slice(0, 16)));
    assert.ok(detailed.stderr.includes(`${finding.path}@${finding.start}`));
    for (let i = 0; i + 6 <= secret.length; i++) {
      assert.ok(!detailed.stderr.includes(secret.slice(i, i + 6)), "report must not leak content");
    }
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});
