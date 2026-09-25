# Architecture

annals is an append-only event store built on git notes. It gives producer
packages a durable envelope and transport without learning what their records
mean. This document describes the invariants behind that boundary.

## Responsibilities

annals owns:

- the event envelope and deterministic identifiers;
- validation, canonical serialization, deduplication, and stable ordering;
- commit anchoring and branch-reachable reads;
- mappings that repair reachability after rebases and squash merges;
- capture-time redaction and the sync-time secret gate; and
- namespaced git-notes transport.

A producer owns the vocabulary identified by `(producer.tool, kind)`, its
`producer.version`, and validation of `content` and `meta`. Store code must not
branch on a producer's kinds except for annals' own bookkeeping records. The
one current compatibility exception is the `reasoning`/`encrypted_content`
redaction exemption described below. It protects opaque ciphertext from
corruption but remains a narrow layering debt, not an extension point.

## Write path

`appendEvents()` performs the following operations:

1. Load the user and repository configuration for the ledger namespace.
2. Ensure the transport hook and fetch refspec exist when enabled.
3. Walk `content` and `raw.data` with capture-tier redaction rules.
4. Finalize and validate each event, including its deterministic `ev2-` id.
5. Warn or refuse according to the configured event-size limits.
6. Acquire the namespace's local writer lock and append canonical JSONL to the
   note on the selected anchor commit.

When a repository has no commit yet, events go into a private pending queue
under the common git directory. The next append after the first commit drains
that queue into the new commit's note.

The note body is sorted canonical JSONL. Concurrent writers are serialized by
the local lock, and existing ids are removed before writing, making repeated
capture idempotent.

## Event identity

The id is a SHA-256 digest over the canonical representation of:

- schema version;
- kind;
- occurrence time;
- stream;
- media type;
- content; and
- links.

Capture context, raw source material, resolved local facts, producer metadata,
recording time, and redaction audit entries do not affect identity. A rescan
under a different commit or a newer producer version therefore keeps the same
identity and duplicate copies collapse deterministically. annals does not
merge metadata between copies. A producer that needs a field to distinguish
facts must put it in `content`.

## Read scope and re-anchoring

Reads default to events whose anchor commits are reachable from `HEAD`.
Maintenance tools can request the entire local ledger by passing
`reachableFrom: null`.

A rebase or squash can remove an anchor commit from the surviving graph.
annals records a `re_anchor` event mapping the old commit to its successor.
Exact tree and patch-id matches may be applied automatically after a fetch.
Fuzzy suggestions remain a producer-CLI workflow that requires a human
decision. Resolution follows mapping chains and only exposes records when the
final successor is reachable from the requested revision.

## Namespaces and transport

A `Ledger` combines repository coordinates with a `NamespaceConfig`. The
namespace controls the local and incoming notes refs, state directory,
configuration paths, recursion guard, and hook command. This keeps independently
rebuildable producer layers independently pushable and removable.

The first append normally installs:

- a fetch refspec that stages the remote note in an incoming ref; and
- a delimited block in a shell `pre-push` hook.

Reads absorb the incoming ref into the local note. Sync fetches and merges
before pushing so divergent append-only histories survive. Pushes default to
anchors reachable from the revisions Git says are being pushed; manual sync
defaults to `HEAD`, while `--all` opts into the whole ledger.

Hooks using `core.hooksPath` or a non-shell format are not modified. Those
repositories must call their namespace CLI's `transport-push` command or run
sync explicitly. Multiple annals namespaces may share a shell hook, although
only the first block can consume Git's stdin; later blocks safely fall back to
`HEAD` scope.

The reusable records-command dispatcher sits above these mechanics but below
producer semantics. It accepts an already-opened ledger plus explicit argv and
I/O streams, so downstream tools can expose a consistent `records` command
namespace without surrendering their top-level vocabulary. Named profiles are
local mappings to complete namespace descriptors; they never infer ownership
from refs and never persist executable hook paths.

## Privacy and integrity

The privacy stack is deliberately layered:

1. **Capture rules** recognize high-confidence credential formats and replace
   them before an event id is computed or bytes reach git notes.
2. **Configured exact values** optionally scrub selected environment values
   and values previously confirmed through a redact workflow.
3. **Standard and paranoid scan rules** inspect records that a sync would newly
   share. These rules may be broader because they block for review rather than
   rewriting silently.
4. **Allowlisted fingerprints** suppress reviewed false positives without
   storing or printing the matched text.
5. **Post-capture redaction** can rewrite records that have not reached the
   remote, preserve their ids, and append an auditable companion record.

Only `content` and `raw.data` are walked. `meta`, `resolved`, context, and
producer information are not secret-bearing fields by contract. A reasoning
record's `encrypted_content` leaf is exempt because modifying ciphertext would
silently corrupt provider replay.

The default sync failure suppresses finding details. An explicitly requested
report contains coordinates and fingerprints, never excerpts. Human review
belongs in a plain terminal because showing the suspicious span inside a
captured agent conversation would create another copy of it.

## Size policy

Git notes replicate to every clone that fetches the namespace. Events should
therefore contain facts, pointers, digests, and spans rather than large
artifacts. The default warning threshold is 5 MB. A producer may configure a
hard maximum when refusing a capture is safer than replication, but capture
paths that must not lose records should keep the default warning-only policy.
