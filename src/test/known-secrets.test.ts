import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  addKnownSecrets,
  knownSecretCount,
  loadKnownSecrets,
  matchingKnownSecrets,
  rememberKnownSecrets,
} from "../redact/known-secrets.js";
import { appendEvents, redactEvent } from "../store.js";
import { cleanupRepo, draft, makeCommit, makeTempRepo } from "./helpers.js";

function knownSecretsPath(gitDir: string): string {
  return join(gitDir, "annals", "known-secrets.json");
}

async function enableKnownSecrets(repoRoot: string): Promise<void> {
  await writeFile(join(repoRoot, ".annals.json"), JSON.stringify({ redact: { knownSecrets: true } }));
}

test("known secrets are salted digests: additive, deduped, and never plaintext", async () => {
  const repo = await makeTempRepo();
  try {
    assert.strictEqual(knownSecretCount(await loadKnownSecrets(repo)), 0);

    // "short" (5 chars) is below the min-length floor and must be dropped;
    // an all-too-short batch must not even create the file.
    await addKnownSecrets(repo, ["short", "tiny"]);
    assert.ok(!existsSync(knownSecretsPath(repo.gitDir)), "no value stuck -> no store file");

    assert.strictEqual(
      await rememberKnownSecrets(repo, ["longenoughvalue", "short", "anothergoodone"]),
      2,
    );
    const first = await loadKnownSecrets(repo);
    assert.strictEqual(knownSecretCount(first), 2);
    assert.deepStrictEqual(matchingKnownSecrets("x anothergoodone y longenoughvalue", first).sort(), [
      "anothergoodone",
      "longenoughvalue",
    ]);
    const raw = await readFile(knownSecretsPath(repo.gitDir), "utf8");
    assert.ok(!raw.includes("anothergoodone"));
    assert.ok(!raw.includes("longenoughvalue"));
    assert.strictEqual((JSON.parse(raw) as { version: number }).version, 2);

    // Additive + idempotent: re-adding an existing value and a new one merges.
    assert.strictEqual(await rememberKnownSecrets(repo, ["longenoughvalue", "thirdgoodvalue"]), 1);
    const second = await loadKnownSecrets(repo);
    assert.strictEqual(knownSecretCount(second), 3);
    assert.deepStrictEqual(matchingKnownSecrets("thirdgoodvalue", second), ["thirdgoodvalue"]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("a legacy plaintext store protects reads and migrates on the next write", async () => {
  const repo = await makeTempRepo();
  try {
    const path = knownSecretsPath(repo.gitDir);
    await mkdir(join(repo.gitDir, "annals"), { recursive: true });
    await writeFile(path, JSON.stringify({ values: ["LEGACY_TESTONLY_value"] }));
    const legacy = await loadKnownSecrets(repo);
    assert.deepStrictEqual(matchingKnownSecrets("has LEGACY_TESTONLY_value here", legacy), [
      "LEGACY_TESTONLY_value",
    ]);

    assert.strictEqual(await rememberKnownSecrets(repo, ["LEGACY_TESTONLY_value"]), 0);
    const raw = await readFile(path, "utf8");
    assert.ok(!raw.includes("LEGACY_TESTONLY_value"));
    assert.strictEqual((JSON.parse(raw) as { version: number }).version, 2);
    assert.deepStrictEqual(
      matchingKnownSecrets("has LEGACY_TESTONLY_value here", await loadKnownSecrets(repo)),
      ["LEGACY_TESTONLY_value"],
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("migration removes legacy plaintext that is now below the remember floor", async () => {
  const repo = await makeTempRepo();
  try {
    const path = knownSecretsPath(repo.gitDir);
    await mkdir(join(repo.gitDir, "annals"), { recursive: true });
    await writeFile(path, JSON.stringify({ values: ["short"] }));
    assert.strictEqual(await rememberKnownSecrets(repo, []), 0);
    const raw = await readFile(path, "utf8");
    assert.ok(!raw.includes("short"));
    assert.strictEqual((JSON.parse(raw) as { version: number }).version, 2);
  } finally {
    await cleanupRepo(repo);
  }
});

test("digest matching preserves Unicode by hashing UTF-16 code units losslessly", async () => {
  const repo = await makeTempRepo();
  try {
    const value = "DUMMY-🔐-secret";
    await addKnownSecrets(repo, [value]);
    assert.deepStrictEqual(matchingKnownSecrets(`before ${value} after`, await loadKnownSecrets(repo)), [
      value,
    ]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("digest matching preserves an unpaired surrogate exactly", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await enableKnownSecrets(repo.root);
    const value = "DUMMY77\ud800";
    await addKnownSecrets(repo, [value]);
    assert.deepStrictEqual(matchingKnownSecrets(`before ${value} after`, await loadKnownSecrets(repo)), [
      value,
    ]);
    const result = await appendEvents(repo, [draft({ content: { text: value } })]);
    assert.ok(!(result.appended[0]!.content as { text: string }).text.includes(value));
    assert.strictEqual(result.appended[0]!.redactions?.length, 1);
  } finally {
    await cleanupRepo(repo);
  }
});

test("concurrent additions serialize without losing remembered digests", async () => {
  const repo = await makeTempRepo();
  try {
    const values = Array.from({ length: 32 }, (_, i) => `DUMMY-concurrent-${i.toString().padStart(2, "0")}`);
    await Promise.all(values.map((value) => addKnownSecrets(repo, [value])));
    const known = await loadKnownSecrets(repo);
    assert.strictEqual(knownSecretCount(known), values.length);
    assert.deepStrictEqual(matchingKnownSecrets(values.join(" "), known).sort(), values.sort());
  } finally {
    await cleanupRepo(repo);
  }
});

test("a corrupt store warns that protection is inactive without leaking bytes", async () => {
  const repo = await makeTempRepo();
  const originalWrite = process.stderr.write;
  let warning = "";
  try {
    const path = knownSecretsPath(repo.gitDir);
    await mkdir(join(repo.gitDir, "annals"), { recursive: true });
    await writeFile(path, "{DUMMY malformed");
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warning += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    assert.strictEqual(knownSecretCount(await loadKnownSecrets(repo)), 0);
    assert.match(warning, /protection is inactive/);
    assert.ok(!warning.includes("malformed"));
  } finally {
    process.stderr.write = originalWrite;
    await cleanupRepo(repo);
  }
});

test("hashed known secrets preserve longest-first replacement for overlaps", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await enableKnownSecrets(repo.root);
    const shorter = "DUMMY-overlap";
    const longer = `${shorter}-extended`;
    await addKnownSecrets(repo, [shorter, longer]);
    const result = await appendEvents(repo, [draft({ content: { text: longer } })]);
    const text = (result.appended[0]!.content as { text: string }).text;
    assert.ok(!text.includes(shorter));
    assert.strictEqual(result.appended[0]!.redactions?.length, 1);
  } finally {
    await cleanupRepo(repo);
  }
});

test("redact --pattern (opt-in on): remembers the scrubbed value, then capture-time redaction scrubs it from a later event", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await enableKnownSecrets(repo.root);
    const secret = "hunter2xK9aa"; // 12 chars, no prefix -> capture tier leaves it raw

    // 1. Capture an event holding the secret; capture tier does not catch it.
    const first = await appendEvents(repo, [
      draft({
        content: { text: `db_password: ${secret}` },
        raw: { format: "test/1", data: { blob: `db_password: ${secret}` } },
      }),
    ]);
    const original = first.appended[0]!;
    assert.ok(JSON.stringify(original).includes(secret), "sanity: secret survives capture tier raw");

    // 2. Human confirms it's a real secret via --pattern; it gets remembered.
    const result = await redactEvent(repo, original.id.slice(4, 12), { pattern: secret });
    assert.strictEqual(result.knownSecretsRemembered, 1);
    assert.strictEqual(knownSecretCount(await loadKnownSecrets(repo)), 1);

    // 3. A *new* event (distinct text so its id differs) mentioning the same
    //    value is now scrubbed automatically at capture time.
    const second = await appendEvents(repo, [
      draft({ content: { text: `reminder, the key was ${secret} last week` } }),
    ]);
    const later = second.appended[0]!;
    assert.ok(!JSON.stringify(later.content).includes(secret), "known value must be scrubbed on ingest");
    assert.ok(
      later.redactions?.some((r) => r.rule === "known-secret"),
      "the scrub must be recorded under the known-secret rule id",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("redact --pattern (opt-in off, the default): nothing is remembered and later captures are not scrubbed", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    const secret = "hunter2xK9aa";

    const first = await appendEvents(repo, [draft({ content: { text: `db_password: ${secret}` } })]);
    const original = first.appended[0]!;

    const result = await redactEvent(repo, original.id.slice(4, 12), { pattern: secret });
    assert.strictEqual(result.knownSecretsRemembered, 0);
    assert.ok(!existsSync(knownSecretsPath(repo.gitDir)), "off by default -> store is never created");

    const second = await appendEvents(repo, [
      draft({ content: { text: `reminder, the key was ${secret} last week` } }),
    ]);
    assert.ok(
      JSON.stringify(second.appended[0]!.content).includes(secret),
      "with the flag off, a later capture of the same value stays raw",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("redact --pattern (opt-in on): a sub-8-char match is scrubbed from the event but not remembered", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await enableKnownSecrets(repo.root);
    const shortSecret = "abc123"; // 6 chars, below the remember floor

    const first = await appendEvents(repo, [draft({ content: { text: `pin=${shortSecret}` } })]);
    const original = first.appended[0]!;

    const result = await redactEvent(repo, original.id.slice(4, 12), { pattern: shortSecret });
    assert.ok(!JSON.stringify(result.event.content).includes(shortSecret), "the event itself is still redacted");
    assert.strictEqual(result.knownSecretsRemembered, 0, "too-short value must not be remembered");
    assert.ok(!existsSync(knownSecretsPath(repo.gitDir)));
  } finally {
    await cleanupRepo(repo);
  }
});

test("redact --all (opt-in on): whole-content blanking remembers nothing (no reusable value)", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await enableKnownSecrets(repo.root);

    const first = await appendEvents(repo, [draft({ content: { text: "db_password: hunter2xK9aa" } })]);
    const original = first.appended[0]!;

    const result = await redactEvent(repo, original.id.slice(4, 12), { all: true });
    assert.strictEqual(result.knownSecretsRemembered, 0);
    assert.ok(!existsSync(knownSecretsPath(repo.gitDir)));
  } finally {
    await cleanupRepo(repo);
  }
});

test("known-secrets store is written owner-read/write only (0600), and bad perms are repaired", async () => {
  const repo = await makeTempRepo();
  try {
    await addKnownSecrets(repo, ["longenoughvalue"]);
    const path = knownSecretsPath(repo.gitDir);
    assert.strictEqual((await stat(path)).mode & 0o777, 0o600, "store must be 0600 on create");

    // Loosen perms as if an older version (or a stray umask) had created it,
    // then confirm the next write repairs them.
    await chmod(path, 0o644);
    assert.strictEqual((await stat(path)).mode & 0o777, 0o644);
    await addKnownSecrets(repo, ["secondgoodvalue"]);
    assert.strictEqual((await stat(path)).mode & 0o777, 0o600, "store perms must be repaired");
  } finally {
    await cleanupRepo(repo);
  }
});

test("known-secrets store lives under .git/ and contains no plaintext", async () => {
  const repo = await makeTempRepo();
  try {
    await addKnownSecrets(repo, ["longenoughvalue"]);
    const path = knownSecretsPath(repo.gitDir);
    assert.ok(existsSync(path));
    assert.ok(path.includes(`${repo.gitDir}/annals/`), "store sits beside the allowlist under .git/");
    assert.ok(!(await readFile(path, "utf8")).includes("longenoughvalue"));
  } finally {
    await cleanupRepo(repo);
  }
});
