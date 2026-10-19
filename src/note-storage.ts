import { randomUUID, createHash } from "node:crypto";
import { git } from "./git.js";
import { notesRef, type Ledger } from "./ledger.js";
import { parseEventLine } from "./schema.js";

// Bounds apply to physical blobs, including a single exceptionally large event.
export const NOTE_BYTES = 4 * 1024 * 1024;
const PART_BYTES = 1024 * 1024;
export const PUSH_BLOB_BYTES = 100 * 1024 * 1024;
interface Entry { key: string; body: string; oid: string; fragment: Part | null }
interface Part { annals_storage: 1; anchor: string; digest: string; part: number; count: number; data: string }
const snapshots = new Map<string, Promise<Entry[]>>();
async function entries(repo: Ledger, ref: string): Promise<Entry[]> {
  const tip = (await git(["rev-parse", "--verify", "--quiet", ref], { cwd: repo.root, allowFailure: true })).trim();
  if (!tip) return [];
  const cacheKey = `${repo.commonDir}:${tip}`;
  let value = snapshots.get(cacheKey);
  if (!value) {
    const previousSnapshots = [...snapshots.values()];
    value = (async () => {
      const reusable = new Map<string, Entry>();
      for (const snapshot of previousSnapshots) {
        for (const entry of await snapshot) reusable.set(entry.oid, entry);
      }
      const list = await git(["ls-tree", "-r", tip], { cwd: repo.root });
      const result: Entry[] = [];
      const keys = new Set<string>();
      for (const row of list.trim().split("\n").filter(Boolean)) {
        const [metadata, path] = row.split("\t");
        const [, type, blob] = metadata!.split(" ");
        const key = path!.replaceAll("/", "");
        if (type !== "blob" || !new RegExp(`^[0-9a-f]{${tip.length}}$`).test(key)) {
          throw new Error("Unsupported entry in notes tree; source retained");
        }
        if (keys.has(key)) throw new Error("Duplicate physical notes key; source retained");
        keys.add(key);
        const cached = reusable.get(blob!);
        if (cached) { result.push({ ...cached, key }); continue; }
        const body = await git(["cat-file", "blob", blob!], { cwd: repo.root });
        const fragment = part(body);
        result.push({ key, oid: blob!, body: fragment ? "" : body, fragment });
      }
      return result;
    })();
    // Source plus previous/current candidate coexist during migration. Entries
    // with unchanged object IDs share their decoded payload across snapshots.
    if (snapshots.size >= 3) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(cacheKey, value);
    value.catch(() => snapshots.delete(cacheKey));
  }
  // Refresh LRU position so a migration's immutable source stays cached.
  snapshots.delete(cacheKey);
  snapshots.set(cacheKey, value);
  return value;
}
function part(body: string): Part | null {
  // Legacy events are JSONL with a schema field, never a storage envelope.
  if (!body.startsWith('{"annals_storage":')) return null;
  let value: Part;
  try { value = JSON.parse(body) as Part; }
  catch { throw new Error("Invalid annals storage fragment JSON"); }
  if (value.annals_storage !== 1 || !/^[0-9a-f]{40,64}$/.test(value.anchor) ||
      !/^[0-9a-f]{64}$/.test(value.digest) || !Number.isSafeInteger(value.count) || value.count < 1 ||
      !Number.isSafeInteger(value.part) || value.part < 0 || value.part >= value.count ||
      typeof value.data !== "string" || (value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))) {
    throw new Error("Invalid annals storage fragment");
  }
  return value;
}
export async function storageAnchors(repo: Ledger, ref = notesRef(repo.ns)): Promise<string[]> {
  return [...new Set((await entries(repo, ref)).map(e => e.fragment?.anchor ?? e.key))];
}
export async function storageLines(repo: Ledger, anchor: string, ref = notesRef(repo.ns)): Promise<string[]> {
  const lines: string[] = [];
  const groups = new Map<string, Map<number, Part>>();
  for (const entry of await entries(repo, ref)) {
    const value = entry.fragment;
    if (!value) {
      if (entry.key === anchor) {
        for (const line of entry.body.split("\n")) if (line.trim()) lines.push(line);
      }
      continue;
    }
    if (value.anchor !== anchor) continue;
    let group = groups.get(value.digest);
    if (!group) { group = new Map(); groups.set(value.digest, group); }
    if (group.has(value.part)) throw new Error("Duplicate annals storage fragment");
    group.set(value.part, value);
  }
  for (const [digest, group] of groups) {
    const first = group.values().next().value!;
    if (group.size !== first.count) throw new Error("Incomplete annals storage record");
    const buffers: Buffer[] = [];
    for (let i = 0; i < first.count; i++) {
      const value = group.get(i);
      if (!value || value.count !== first.count) throw new Error("Inconsistent annals storage record");
      buffers.push(Buffer.from(value.data, "base64"));
    }
    const bytes = Buffer.concat(buffers);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("Corrupt annals storage record");
    for (const line of bytes.toString("utf8").split("\n")) if (line) lines.push(line);
  }
  // Identity deliberately excludes provenance: preserve distinct serialized variants.
  return [...new Set(lines)].sort();
}

/** Build privately, then compare-and-swap the destination. Failed writes retain the original. */
export async function writeStorageLines(repo: Ledger, anchor: string, lines: string[], ref = notesRef(repo.ns), expectedTip?: string): Promise<void> {
  const old = (await git(["rev-parse", "--verify", "--quiet", ref], { cwd: repo.root, allowFailure: true })).trim();
  if (expectedTip !== undefined && expectedTip !== old) throw new Error("Notes changed during write; retry without discarding pending records");
  const hashLength = old.length || (await git(["hash-object", "--stdin"], { cwd: repo.root, input: "" })).trim().length;
  const existing = old ? await entries(repo, old) : [];
  const desired = new Map<string, string>();
  // Pack small records together. Split large records as bytes, never truncate them.
  const batches: string[] = [];
  let batch: string[] = [];
  let size = 0;
  for (const line of [...new Set(lines)].sort()) {
    try { parseEventLine(line); }
    catch { throw new Error("Invalid stored event JSON; source and backup retained"); }
    const bytes = Buffer.byteLength(line) + 1;
    if (batch.length && size + bytes > PART_BYTES) { batches.push(batch.join("\n")); batch = []; size = 0; }
    batch.push(line); size += bytes;
  }
  if (batch.length) batches.push(batch.join("\n"));
  for (const body of batches) {
    const bytes = Buffer.from(body);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const count = Math.ceil(bytes.length / PART_BYTES);
    for (let i = 0; i < count; i++) {
      const value: Part = { annals_storage: 1, anchor, digest, part: i, count,
        data: bytes.subarray(i * PART_BYTES, (i + 1) * PART_BYTES).toString("base64") };
      const key = createHash(hashLength === 64 ? "sha256" : "sha1").update(`annals-storage-v1:${anchor}:${digest}:${i}`).digest("hex");
      desired.set(key, JSON.stringify(value) + "\n");
    }
  }
  const treeEntries = new Map<string, string>();
  for (const entry of existing) {
    const entryAnchor = entry.fragment?.anchor ?? entry.key;
    if (entryAnchor !== anchor) {
      if (desired.has(entry.key)) throw new Error("Annals storage key collision");
      treeEntries.set(entry.key, entry.oid);
    }
  }
  const previous = new Map(existing.map(e => [e.key, e]));
  for (const [key, body] of desired) {
    if (Buffer.byteLength(body) > NOTE_BYTES) throw new Error("Annals storage bound exceeded");
    const prior = previous.get(key);
    const objectId = createHash(hashLength === 64 ? "sha256" : "sha1")
      .update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest("hex");
    const oid = prior?.oid === objectId ? prior.oid : (await git(["hash-object", "-w", "--stdin"], { cwd: repo.root, input: body })).trim();
    treeEntries.set(key, oid);
  }
  // One flat notes tree and one commit, regardless of fragment count. No user index.
  const tree = (await git(["mktree"], { cwd: repo.root, input: [...treeEntries].sort(([a], [b]) => a.localeCompare(b)).map(([key, oid]) => `100644 blob ${oid}\t${key}\n`).join("") })).trim();
  const next = (await git(["commit-tree", tree, ...(old ? ["-p", old] : []), "-m", "annals: bounded notes snapshot"], { cwd: repo.root })).trim();
  await git(["update-ref", ref, next, old || "0".repeat(hashLength)], { cwd: repo.root });
}

/** Includes historical blobs. Object names/paths and record bodies are never returned. */
export async function auditObjects(repo: Ledger, ref = notesRef(repo.ns), limit = PUSH_BLOB_BYTES): Promise<Array<{ oid: string; bytes: number }>> {
  const objects = await git(["rev-list", "--objects", "--no-object-names", ref], { cwd: repo.root });
  const sizes = await git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { cwd: repo.root, input: objects });
  return sizes.trim().split("\n").flatMap(row => {
    const [oid, type, size] = row.split(" ");
    return type === "blob" && Number(size) > limit ? [{ oid: oid!, bytes: Number(size) }] : [];
  });
}
export async function assertPushObjects(repo: Ledger, ref: string): Promise<void> {
  const oversized = await auditObjects(repo, ref);
  if (oversized.length) throw new Error(`Notes push blocked: ${oversized.length} reachable blob(s) exceed ${PUSH_BLOB_BYTES} bytes, including historical objects. Prepare a backed-up storage migration; no push attempted.`);
}

/** Creates a backup and a verified independently rooted candidate; never replaces the live ref. */
export async function prepareStorageMigration(repo: Ledger): Promise<{ source: string; backup: string; candidate: string; tip: string; anchors: number; events: number }> {
  const source = (await git(["rev-parse", notesRef(repo.ns)], { cwd: repo.root })).trim();
  const token = randomUUID();
  const backup = `refs/annals-backups/${repo.ns.name}/${token}`;
  const candidate = `refs/notes/${repo.ns.name}-migration-${token}`;
  await git(["update-ref", backup, source, "0".repeat(source.length)], { cwd: repo.root });
  let events = 0;
  const emptyTree = (await git(["mktree"], { cwd: repo.root, input: "" })).trim();
  const emptyCommit = (await git(["commit-tree", emptyTree, "-m", "annals: storage migration root"], { cwd: repo.root })).trim();
  await git(["update-ref", candidate, emptyCommit, "0".repeat(source.length)], { cwd: repo.root });
  const anchors = await storageAnchors(repo, source);
  for (const anchor of anchors) {
    const lines = await storageLines(repo, anchor, source);
    await writeStorageLines(repo, anchor, lines, candidate);
    const restored = await storageLines(repo, anchor, candidate);
    if (lines.length !== restored.length || lines.some((line, i) => line !== restored[i])) throw new Error("Migration verification failed; source and backup retained");
    events += lines.length;
  }
  await assertPushObjects(repo, candidate);
  // Candidate commits contain only bounded snapshots; no source parent is imported.
  const tip = (await git(["rev-parse", candidate], { cwd: repo.root })).trim();
  const current = (await git(["rev-parse", notesRef(repo.ns)], { cwd: repo.root })).trim();
  if (current !== source) throw new Error("Source changed during migration; candidate is stale, backup retained");
  return { source, backup, candidate, tip, anchors: anchors.length, events };
}
