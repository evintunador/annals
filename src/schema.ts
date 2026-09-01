import { canonicalJson, sha256Hex } from "./canonical.js";
import type { RedactionRecord } from "./redact/apply.js";

export const SCHEMA_VERSION = "annals/v1";

/**
 * `kind` is an open string identified by the pair (producer.tool, kind);
 * annals stores every kind verbatim and never interprets `content`. A
 * producer owns its kinds, their versioning (producer.version), and their
 * reader. The only kinds annals itself emits are its bookkeeping:
 * `redaction` (a record was rewritten to remove a secret) and `re_anchor`
 * (anchor commits were rewritten away by a squash/rebase).
 */
export interface Actor {
  /** "human" | "agent" | "system" */
  type: string;
  /** Stable identity when known, e.g. git author email or model id. */
  id?: string;
  display?: string;
}

export interface Producer {
  /** Tool that wrote this event, e.g. "cledger", "turnbridge". */
  tool: string;
  /** Capture tool version. Not part of event identity. */
  version?: string;
  /** Source system the content came from, e.g. "claude-code", "codex". */
  source?: string;
  /**
   * The source system's own version — the coding CLI's version, not
   * the writing tool's (that is `version`), e.g. "2.1.220" for claude-code or
   * "0.145.0" for codex. Not part of event identity.
   */
  source_version?: string;
  /**
   * Model that served this turn, verbatim as the source names it, e.g.
   * "claude-opus-5" or "gpt-5.6-sol". Set only when the source states it
   * for this turn — never guessed, never carried across turns the source
   * did not label. Not part of event identity.
   */
  model?: string;
  /**
   * Inference provider serving `model`, verbatim as the source names it,
   * e.g. "openai". Set only when the source states it — notably *not*
   * inferred from `source` or from the model id, since the same CLI can be
   * pointed at a first-party API, a cloud reseller, or a local endpoint.
   * Not part of event identity.
   */
  provider?: string;
  /** Source system's native session identifier. */
  session_id?: string;
}

/**
 * The source-stated agent facts an adapter attaches to `producer`. Adapters
 * gather these from wherever the source records them — a per-line field, a
 * preceding session/turn-context line — and spread them onto every event
 * they emit for that part of the transcript.
 */
export type ProducerAgentContext = Pick<Producer, "source_version" | "model" | "provider">;

export interface RepoContext {
  /** Best-known repository identity (origin URL or top-level dir name). */
  repo?: string;
  branch?: string;
  /** HEAD commit SHA at capture time. */
  head?: string;
  /** Working directory the conversation ran in. */
  cwd?: string;
  /** sha256 of `git status --porcelain` output when the tree was dirty. */
  dirty_fingerprint?: string;
}

export interface StreamRef {
  /** Namespaced stream id, e.g. "claude-code:<session uuid>". */
  id: string;
  /** Stable ordering key within the stream (source line index). */
  seq: number;
  /**
   * The stream this one was spawned from, when it is a sub-stream — a
   * subagent conversation, a child run. Sub-streams get their own `id` (so a
   * consumer can isolate one) and point back here (so the tree can be
   * reassembled).
   *
   * Part of event identity, like the rest of `StreamRef`: it is stated by
   * the source, stable across rescans, and distinguishes a sub-stream's
   * record from an identical-looking parent record.
   */
  parent?: string;
}

export interface EventLink {
  /** e.g. "redacts", "supersedes", "annotates", "replies_to" */
  rel: string;
  /** Target event id. */
  target: string;
}

export interface EvidenceEvent {
  /** "ev2-" + sha256 of the identity subset (see eventId). */
  id: string;
  schema: typeof SCHEMA_VERSION;
  kind: string;
  /** When the content happened, ISO 8601 UTC (from the source when known). */
  occurred_at: string;
  /** When this event was appended. Not part of identity. */
  recorded_at: string;
  actor: Actor;
  producer: Producer;
  /** IANA media type of `content`; defaults to application/json. */
  media_type?: string;
  /** The visible content itself, stored inline and never reinterpreted. */
  content: unknown;
  /** Repository context at capture time. Not part of identity. */
  context?: RepoContext;
  /** Grouping + ordering: which stream of records this belongs to and
   * where. For cledger a stream is a conversation; for a training-run
   * producer it might be a run. */
  stream?: StreamRef;
  links?: EventLink[];
  /**
   * Opaque source-native payload for lossless export, e.g. the original
   * transcript line(s). Versioned by `format`. Not part of identity.
   */
  raw?: { format: string; data: unknown };
  /**
   * What the ledger could resolve, at capture time, of pointers the source
   * line only names. A Claude Code `file-history-snapshot` says a file's
   * bytes live at `<backup file>` under a machine-local cache directory; this
   * is where the sha256 and size the ledger read from that file go, so the
   * record can be verified later even though the cache itself is prunable and
   * unshareable.
   *
   * Excluded from the identity subset, and that exclusion is the point: the
   * same transcript line resolves differently on a machine without the cache,
   * or after the cache is pruned, and identity must answer "which piece of
   * source material is this", not "what could this machine see at the time".
   * Folding it in would make a rescan after a prune duplicate every snapshot
   * rather than dedup it.
   *
   * Holds derived facts about local state — digests, sizes, counts — never
   * file bodies: the redaction stack walks `content` and `raw.data`, not this,
   * so anything secret-bearing put here would bypass it.
   */
  resolved?: Record<string, unknown>;
  /**
   * Capture-time redaction records (rule id, ruleset version, fingerprint,
   * location path), present when the capture-tier ruleset rewrote part of
   * `content`/`raw.data` before this event was finalized. Deliberately
   * excluded from the identity subset: the rewritten `content` already
   * determines `id`, so including this here would double-count the same
   * fact and would churn ids on ruleset upgrades even when the visible
   * content is unchanged.
   */
  redactions?: RedactionRecord[];
}

/** Fields an adapter supplies; id/schema/recorded_at are filled at append. */
export type EventDraft = Omit<EvidenceEvent, "id" | "schema" | "recorded_at"> &
  Partial<Pick<EvidenceEvent, "id" | "schema" | "recorded_at">>;

/**
 * Event identity is derived from the durable, source-determined subset so
 * that re-scanning the same source material always yields the same id
 * (idempotent capture). Volatile provenance — recorded_at, context, raw,
 * producer.version/tool — is deliberately excluded: a re-ingestion under a
 * different HEAD or adapter version must dedup, not duplicate.
 *
 * `producer.model`/`provider`/`source_version` are excluded for the same
 * reason even though they *are* source-determined and stable per line. They
 * were added after events had already been captured without them, so folding
 * them into identity would give the very same transcript line a different id
 * before and after the upgrade — a rescan would duplicate every pre-upgrade
 * turn rather than dedup it. Identity answers "which piece of source material
 * is this"; the model that served it is provenance about that material, not
 * a second copy of it.
 */
export function eventId(event: EventDraft): string {
  const identity = {
    schema: SCHEMA_VERSION,
    kind: event.kind,
    occurred_at: event.occurred_at,
    actor: { type: event.actor.type, id: event.actor.id },
    source: event.producer.source,
    session_id: event.producer.session_id,
    stream: event.stream,
    media_type: event.media_type,
    content: event.content,
    links: event.links,
  };
  return "ev2-" + sha256Hex(canonicalJson(identity));
}

export function finalizeEvent(draft: EventDraft, now = new Date()): EvidenceEvent {
  const event: EvidenceEvent = {
    ...draft,
    id: draft.id ?? eventId(draft),
    schema: SCHEMA_VERSION,
    recorded_at: draft.recorded_at ?? now.toISOString(),
  };
  const problems = validateEvent(event);
  if (problems.length > 0) {
    throw new Error(`invalid event: ${problems.join("; ")}`);
  }
  return event;
}

export function validateEvent(event: EvidenceEvent): string[] {
  const problems: string[] = [];
  if (!event.id?.startsWith("ev2-")) problems.push("id must start with ev2-");
  if (event.schema !== SCHEMA_VERSION) problems.push(`schema must be ${SCHEMA_VERSION}`);
  if (!event.kind) problems.push("kind is required");
  if (!isIsoDate(event.occurred_at)) problems.push("occurred_at must be ISO 8601");
  if (!isIsoDate(event.recorded_at)) problems.push("recorded_at must be ISO 8601");
  if (!event.actor?.type) problems.push("actor.type is required");
  if (!event.producer?.tool) problems.push("producer.tool is required");
  if (event.content === undefined) problems.push("content is required");
  return problems;
}

function isIsoDate(s: unknown): boolean {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

/** One event per line, canonical bytes — the note storage format. */
export function serializeEvent(event: EvidenceEvent): string {
  return canonicalJson(event);
}

export function parseEventLine(line: string): EvidenceEvent {
  return JSON.parse(line) as EvidenceEvent;
}
