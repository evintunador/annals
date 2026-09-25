/**
 * Opt-in local store of confirmed secrets, retained only as salted digests.
 * Capture checks candidate string windows against those digests, so it can
 * still exact-match a remembered value without keeping a reversible copy.
 *
 * The reader accepts the old `{values:[...]}` shape so capture remains
 * protective before migration. The next add rewrites every legacy value as a
 * digest and removes the plaintext from disk.
 *
 * Each entry also carries a salted four-bit rolling bucket. It intentionally
 * leaks four checksum bits (never enough to identify a value) to avoid hashing
 * every possible window. The full salted digest is always the authority and
 * prevents cross-store digest precomputation; the bucket itself makes no such
 * claim. This keeps a 1 MiB capture with many remembered lengths near one
 * second rather than tens of seconds.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ledger } from "../ledger.js";

const STORE_MODE = 0o600;
const STORE_VERSION = 2;
const MIN_VALUE_LENGTH = 8;
const DIGEST_CONTEXT = "annals-known-secret-v2\0";
const ROLLING_BASE = 257;
const BUCKET_MASK = 0x0f;

export interface KnownSecretDigest {
  /** JavaScript UTF-16 code-unit length, used to generate exact candidates. */
  length: number;
  /** sha256(DIGEST_CONTEXT || salt || lossless UTF-16LE secret), hex. */
  digest: string;
  /** Four-bit salted rolling prefilter; the digest remains authoritative. */
  bucket: number;
}

/** Opaque matching material. It contains plaintext only while reading v1. */
export interface KnownSecrets {
  salt: string | null;
  secrets: KnownSecretDigest[];
  legacyValues: string[];
  /** True when the on-disk shape must be rewritten even if it held no usable value. */
  needsMigration: boolean;
}

interface KnownSecretsFileV2 {
  version: 2;
  salt: string;
  secrets: KnownSecretDigest[];
}

function knownSecretsPath(repo: Ledger): string {
  return join(repo.commonDir, repo.ns.stateDirName, "known-secrets.json");
}

async function withKnownSecretsLock<T>(repo: Ledger, fn: () => Promise<T>): Promise<T> {
  const stateDir = join(repo.commonDir, repo.ns.stateDirName);
  await mkdir(stateDir, { recursive: true });
  const lockDir = join(stateDir, "known-secrets.lock");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Never steal a lock. A paused former owner cannot distinguish a
      // replacement at the same path and could delete its successor's lock on
      // resume, allowing two read-modify-write cycles to overlap. A crashed
      // writer therefore fails closed until this local lock directory is
      // removed deliberately.
      if (Date.now() > deadline) {
        throw new Error(
          `${repo.ns.cliName}: timed out updating known secrets; ` +
            `if no ${repo.ns.cliName} process is running, remove ${lockDir}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function encodeString(value: string): Buffer {
  // Buffer.from(value, "utf8") replaces unpaired surrogates with U+FFFD. Git
  // notes can contain arbitrary JS strings, so hash code units losslessly.
  const out = Buffer.allocUnsafe(value.length * 2);
  for (let i = 0; i < value.length; i++) out.writeUInt16LE(value.charCodeAt(i), i * 2);
  return out;
}

function digestString(saltHex: string, value: string): string {
  return createHash("sha256")
    .update(DIGEST_CONTEXT)
    .update(Buffer.from(saltHex, "hex"))
    .update(encodeString(value))
    .digest("hex");
}

function rollingSalt(saltHex: string): number {
  return Number.parseInt(saltHex.slice(0, 8), 16) >>> 0;
}

function rollingTerm(codeUnit: number, salt: number): number {
  return (codeUnit + salt) >>> 0;
}

function rollingHash(value: string, saltHex: string): number {
  const salt = rollingSalt(saltHex);
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(hash, ROLLING_BASE) + rollingTerm(value.charCodeAt(i), salt)) >>> 0;
  }
  return hash;
}

function rollingBucket(value: string, saltHex: string): number {
  return rollingHash(value, saltHex) & BUCKET_MASK;
}

function validSalt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    value.length % 2 === 0 &&
    /^[0-9a-f]+$/.test(value)
  );
}

function validDigest(value: unknown): value is KnownSecretDigest {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(entry["length"]) &&
    (entry["length"] as number) >= MIN_VALUE_LENGTH &&
    typeof entry["digest"] === "string" &&
    /^[0-9a-f]{64}$/.test(entry["digest"]) &&
    Number.isInteger(entry["bucket"]) &&
    (entry["bucket"] as number) >= 0 &&
    (entry["bucket"] as number) <= BUCKET_MASK
  );
}

/** Missing or malformed stores are empty, so a capture hook never wedges. */
export async function loadKnownSecrets(repo: Ledger): Promise<KnownSecrets> {
  try {
    const parsed = JSON.parse(await readFile(knownSecretsPath(repo), "utf8")) as Record<string, unknown>;
    if (
      parsed["version"] === STORE_VERSION &&
      validSalt(parsed["salt"]) &&
      Array.isArray(parsed["secrets"])
    ) {
      const unique = new Map<string, KnownSecretDigest>();
      for (const value of parsed["secrets"]) {
        if (!validDigest(value)) throw new Error("invalid digest entry");
        unique.set(`${value.length}:${value.digest}`, value);
      }
      return {
        salt: parsed["salt"],
        secrets: [...unique.values()].sort(
          (a, b) => a.length - b.length || a.digest.localeCompare(b.digest),
        ),
        legacyValues: [],
        needsMigration: false,
      };
    }
    if (!Array.isArray(parsed["values"]) || !parsed["values"].every((v) => typeof v === "string")) {
      throw new Error("unrecognized store shape");
    }
    const values = parsed["values"].filter((value) => value.length >= MIN_VALUE_LENGTH);
    return {
      salt: null,
      secrets: [],
      legacyValues: [...new Set(values)],
      needsMigration: Array.isArray(parsed["values"]),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `${repo.ns.cliName}: warning: known-secrets store is unreadable; ` +
          `remembered-secret protection is inactive until the file is repaired\n`,
      );
    }
    return { salt: null, secrets: [], legacyValues: [], needsMigration: false };
  }
}

export function knownSecretCount(known: KnownSecrets): number {
  return known.secrets.length + known.legacyValues.length;
}

/**
 * Return exact remembered values found in one string. Candidate plaintext
 * exists only in memory for this call; it cannot be recovered from the store.
 */
export function matchingKnownSecrets(text: string, known: KnownSecrets): string[] {
  const found = new Set<string>();
  for (const value of known.legacyValues) {
    if (text.includes(value)) found.add(value);
  }
  if (known.salt === null || known.secrets.length === 0) return [...found];

  const byLength = new Map<number, Map<number, Set<string>>>();
  for (const entry of known.secrets) {
    const buckets = byLength.get(entry.length) ?? new Map<number, Set<string>>();
    const digests = buckets.get(entry.bucket) ?? new Set<string>();
    digests.add(entry.digest);
    buckets.set(entry.bucket, digests);
    byLength.set(entry.length, buckets);
  }
  const salt = rollingSalt(known.salt);
  for (const [length, buckets] of byLength) {
    if (length > text.length) continue;
    let power = 1;
    for (let i = 1; i < length; i++) power = Math.imul(power, ROLLING_BASE) >>> 0;
    let rolling = rollingHash(text.slice(0, length), known.salt);
    for (let start = 0; start <= text.length - length; start++) {
      const digests = buckets.get(rolling & BUCKET_MASK);
      if (digests) {
        const candidate = text.slice(start, start + length);
        if (digests.has(digestString(known.salt, candidate))) found.add(candidate);
      }
      if (start < text.length - length) {
        const outgoing = rollingTerm(text.charCodeAt(start), salt);
        const incoming = rollingTerm(text.charCodeAt(start + length), salt);
        rolling = Math.imul((rolling - Math.imul(outgoing, power)) >>> 0, ROLLING_BASE) >>> 0;
        rolling = (rolling + incoming) >>> 0;
      }
    }
  }
  return [...found];
}

/**
 * Add confirmed values and persist only salted digests. Returns the number of
 * newly remembered values. Calling this on a v1 plaintext store migrates it
 * even when every supplied value was already present.
 */
export async function rememberKnownSecrets(repo: Ledger, values: string[]): Promise<number> {
  return withKnownSecretsLock(repo, async () => {
    const current = await loadKnownSecrets(repo);
    const salt = current.salt ?? randomBytes(16).toString("hex");
    const entries = new Map<string, KnownSecretDigest>();
    for (const entry of current.secrets) entries.set(`${entry.length}:${entry.digest}`, entry);
    for (const value of current.legacyValues) {
      const entry = {
        length: value.length,
        digest: digestString(salt, value),
        bucket: rollingBucket(value, salt),
      };
      entries.set(`${entry.length}:${entry.digest}`, entry);
    }

    let added = 0;
    for (const value of new Set(values)) {
      if (value.length < MIN_VALUE_LENGTH) continue;
      const entry = {
        length: value.length,
        digest: digestString(salt, value),
        bucket: rollingBucket(value, salt),
      };
      const key = `${entry.length}:${entry.digest}`;
      if (entries.has(key)) continue;
      entries.set(key, entry);
      added++;
    }

    if (entries.size === 0 && !current.needsMigration) return 0;
    if (added === 0 && !current.needsMigration) return 0;
    const path = knownSecretsPath(repo);
    const file: KnownSecretsFileV2 = {
      version: STORE_VERSION,
      salt,
      secrets: [...entries.values()].sort(
        (a, b) => a.length - b.length || a.digest.localeCompare(b.digest),
      ),
    };
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", { mode: STORE_MODE });
      await chmod(temporary, STORE_MODE);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return added;
  });
}

/** Backward-compatible public writer; callers that need the added count use rememberKnownSecrets. */
export async function addKnownSecrets(repo: Ledger, values: string[]): Promise<void> {
  await rememberKnownSecrets(repo, values);
}
