import { test } from "node:test";
import assert from "node:assert/strict";
import { git } from "../git.js";
import { notesRef } from "../ledger.js";
import { serializeEvent } from "../schema.js";
import { appendEvents, readEvents, sync } from "../store.js";
import { auditObjects, assertPushObjects, NOTE_BYTES, prepareStorageMigration, storageLines, writeStorageLines } from "../note-storage.js";
import { cleanupDir, cleanupRepo, draft, event, makeBareRepo, makeCommit, makeTempRepo } from "./helpers.js";

test("bounded storage packs cumulative growth and splits a single Unicode record without changing bytes", async () => {
  const repo = await makeTempRepo();
  try {
    const anchor = await makeCommit(repo);
    const lines = Array.from({ length: 5000 }, (_, i) => serializeEvent(event({ content: { i, text: "EXAMPLE".repeat(150) } })));
    lines.push(serializeEvent(event({ content: { text: "🦊".repeat(1_400_000) } })));
    await writeStorageLines(repo, anchor, lines);
    assert.deepEqual(await storageLines(repo, anchor), [...lines].sort());
    assert.deepEqual(await auditObjects(repo, notesRef(repo.ns), NOTE_BYTES), []);
    const count = (await git(["notes", "--ref", repo.ns.name, "list"], { cwd: repo.root })).trim().split("\n").length;
    assert.ok(count < 30, `packed 5001 records into ${count} blobs`);
    const old = (await git(["rev-parse", notesRef(repo.ns)], { cwd: repo.root })).trim();
    await appendEvents(repo, [draft({ content: { text: "one more EXAMPLE" } })]);
    assert.equal((await git(["rev-parse", `${notesRef(repo.ns)}^`], { cwd: repo.root })).trim(), old);
    assert.equal((await storageLines(repo, anchor)).length, 5002);
    assert.deepEqual(await auditObjects(repo, notesRef(repo.ns), NOTE_BYTES), []);
  } finally { await cleanupRepo(repo); }
});

test("migration backs up immutable source, preserves provenance variants and redactions, and excludes old blobs", async () => {
  const repo = await makeTempRepo();
  try {
    const anchor = await makeCommit(repo);
    const original = event({ content: { text: "EXAMPLE".repeat(800_000) } });
    const redacted = { ...original, content: { text: "REDACTED EXAMPLE" }, redactions: [{ rule: "manual", ruleset: "1", fingerprint: "0123456789ab", path: "content" }] };
    const lines = [serializeEvent(redacted), serializeEvent({ ...redacted, recorded_at: "2026-02-01T00:00:00.000Z" })].sort();
    // Oversized previous snapshot, followed by an already-reviewed current snapshot.
    await git(["notes", "--ref", repo.ns.name, "add", "-F", "-", anchor], { cwd: repo.root, input: serializeEvent(original) + "\n" });
    await git(["notes", "--ref", repo.ns.name, "add", "-f", "-F", "-", anchor], { cwd: repo.root, input: lines.join("\n") + "\n" });
    const result = await prepareStorageMigration(repo);
    assert.equal(result.events, 2);
    assert.equal(result.anchors, 1);
    assert.equal((await git(["rev-parse", notesRef(repo.ns)], { cwd: repo.root })).trim(), result.source);
    assert.equal((await git(["rev-parse", result.backup], { cwd: repo.root })).trim(), result.source);
    assert.deepEqual(await storageLines(repo, anchor, result.candidate), lines);
    assert.equal((await auditObjects(repo, result.backup, NOTE_BYTES)).length, 1);
    assert.deepEqual(await auditObjects(repo, result.candidate, NOTE_BYTES), []);
    assert.equal((await git(["rev-list", "--count", result.candidate], { cwd: repo.root })).trim(), "2");
  } finally { await cleanupRepo(repo); }
});

test("historical oversized objects block an unscoped push before the remote changes", async () => {
  const repo = await makeTempRepo();
  const remote = await makeBareRepo();
  try {
    const anchor = await makeCommit(repo);
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    const blob = (await git(["hash-object", "-w", "--stdin"], { cwd: repo.root, input: "x".repeat(100 * 1024 * 1024 + 1) })).trim();
    await git(["notes", "--ref", repo.ns.name, "add", "-C", blob, anchor], { cwd: repo.root });
    const line = serializeEvent(event());
    await git(["notes", "--ref", repo.ns.name, "add", "-f", "-F", "-", anchor], { cwd: repo.root, input: line + "\n" });
    await assert.rejects(assertPushObjects(repo, notesRef(repo.ns)), /historical objects/);
    await assert.rejects(sync(repo, "origin", "push", { scope: null, skipScan: true }), /no push attempted/);
    assert.equal((await git(["ls-remote", "origin", notesRef(repo.ns)], { cwd: repo.root })).trim(), "");
    // A scoped snapshot imports current records, not the oversized local ancestors.
    await sync(repo, "origin", "push", { skipScan: true });
  } finally { await cleanupRepo(repo); await cleanupDir(remote); }
});

test("concurrent fragments and legacy notes union without losing provenance or widening scope", async () => {
  const a = await makeTempRepo();
  const b = await makeTempRepo();
  const remote = await makeBareRepo();
  try {
    const anchor = await makeCommit(a);
    await git(["remote", "add", "origin", remote], { cwd: a.root });
    await git(["push", "origin", "main"], { cwd: a.root });
    await git(["remote", "add", "origin", remote], { cwd: b.root });
    await git(["fetch", "origin", "main"], { cwd: b.root });
    await git(["checkout", "-B", "main", "FETCH_HEAD"], { cwd: b.root });
    const first = event({ content: { text: "EXAMPLE A" } });
    const second = { ...first, recorded_at: "2026-02-01T00:00:00.000Z", context: { repo: "EXAMPLE B", cwd: b.root } };
    await writeStorageLines(a, anchor, [serializeEvent(first)]);
    await git(["notes", "--ref", b.ns.name, "add", "-F", "-", anchor], { cwd: b.root, input: serializeEvent(second) + "\n" });
    await sync(a, "origin", "push", { skipScan: true });
    await sync(b, "origin", "both", { skipScan: true });
    await sync(a, "origin", "fetch");
    assert.deepEqual(await storageLines(a, anchor), [serializeEvent(first), serializeEvent(second)].sort());
    assert.equal((await readEvents(a)).length, 1, "existing logical dedup remains in effect");
  } finally { await cleanupRepo(a); await cleanupRepo(b); await cleanupDir(remote); }
});

test("missing or corrupt large-event fragments fail closed", async () => {
  const repo = await makeTempRepo();
  try {
    const anchor = await makeCommit(repo);
    await writeStorageLines(repo, anchor, [serializeEvent(event({ content: { text: "EXAMPLE".repeat(400_000) } }))]);
    const key = (await git(["notes", "--ref", repo.ns.name, "list"], { cwd: repo.root })).trim().split("\n")[0]!.split(" ")[1]!;
    await git(["notes", "--ref", repo.ns.name, "remove", key], { cwd: repo.root });
    await assert.rejects(storageLines(repo, anchor), /Incomplete annals storage record/);
  } finally { await cleanupRepo(repo); }
});

test("repacking shared multi-batch ancestors merges all concurrent records", async () => {
  const repo = await makeTempRepo();
  try {
    const anchor = await makeCommit(repo);
    const shared = Array.from({ length: 2000 }, (_, i) => serializeEvent(event({ content: { i, text: "EXAMPLE".repeat(150) } })));
    await writeStorageLines(repo, anchor, shared);
    const ref = notesRef(repo.ns);
    const base = (await git(["rev-parse", ref], { cwd: repo.root })).trim();
    const peer = "refs/notes/test-peer";
    await git(["update-ref", peer, base], { cwd: repo.root });
    const local = serializeEvent(event({ content: { text: "EXAMPLE LOCAL" } }));
    const remote = serializeEvent(event({ content: { text: "EXAMPLE REMOTE" } }));
    await writeStorageLines(repo, anchor, [...shared, local]);
    await writeStorageLines(repo, anchor, [...shared, remote], peer);
    await git(["notes", "--ref", repo.ns.name, "merge", "-s", "cat_sort_uniq", peer], { cwd: repo.root });
    assert.deepEqual(await storageLines(repo, anchor), [...shared, local, remote].sort());
    assert.deepEqual(await auditObjects(repo, ref, NOTE_BYTES), []);
    // A stale expected source cannot overwrite the concurrent merge.
    await assert.rejects(writeStorageLines(repo, anchor, shared, ref, base), /Notes changed/);
    assert.equal((await storageLines(repo, anchor)).length, 2002);
  } finally { await cleanupRepo(repo); }
});

test("corrupt fragment bytes fail digest verification without exposing data", async () => {
  const repo = await makeTempRepo();
  try {
    const anchor = await makeCommit(repo);
    await writeStorageLines(repo, anchor, [serializeEvent(event())]);
    const [blob, key] = (await git(["notes", "--ref", repo.ns.name, "list"], { cwd: repo.root })).trim().split(" ");
    const value = JSON.parse(await git(["cat-file", "blob", blob!], { cwd: repo.root }));
    value.data = Buffer.from("CORRUPT EXAMPLE").toString("base64");
    await git(["notes", "--ref", repo.ns.name, "add", "-f", "-F", "-", key!], { cwd: repo.root, input: JSON.stringify(value) + "\n" });
    await assert.rejects(storageLines(repo, anchor), { message: "Corrupt annals storage record" });
  } finally { await cleanupRepo(repo); }
});
