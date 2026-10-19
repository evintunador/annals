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
6. Acquire the namespace's local writer lock and pack the anchor's canonical
   JSONL into bounded fragment notes. Publish one notes tree with a
   compare-and-swap ref update.

When a repository has no commit yet, events go into a private pending queue
under the common git directory. The next append after the first commit drains
that queue into the new commit's logical note. The pending file is removed
only after the notes write succeeds.

The logical note is sorted canonical JSONL. Concurrent writers are serialized by
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

## Bounded notes and recovery

Legacy storage accumulates every record at an anchor into one JSONL blob.
Both the current note and all preceding snapshots are reachable through the
notes ref's own commit parents. Git compression does not reduce a blob's
uncompressed size for a hosting limit. Replacing a giant current note therefore
does not make its oversized ancestors safe to push.

New writes store content-addressed physical notes, each at most 4 MiB. Sorted
complete lines are packed into batches of at most 1 MiB (except a single larger
line); batches are split at 1 MiB byte boundaries. Each fragment is a JSON
storage envelope with `annals_storage: 1`, `anchor`, SHA-256 `digest` of the
whole batch, zero-based `part`, total `count`, and base64 `data`. Unicode byte
boundaries need not coincide with fragment boundaries: bytes are reassembled
before UTF-8 decoding. No event field is changed. This format does not examine
producer-owned content or metadata.

The physical note key hashes the domain `annals-storage-v1`, anchor, batch
digest, and part number, separated by colons, with the repository's Git object
hash algorithm. Physical keys are storage addresses, never logical anchors.
All fragment blobs are entries in the notes commit's tree, so ref fetch/push,
GC reachability and native `cat_sort_uniq` merges retain them. There are no
external pointers. New writes construct a flat tree without touching the user
index, reuse unchanged blob IDs, and publish one commit with compare-and-swap.
Existing fanout trees are read recursively. Unsupported non-note tree entries
cause refusal rather than silently dropping objects.

Readers enumerate logical anchors from fragment envelopes and legacy note
keys. They require complete, consistent fragment sets and matching digests,
then union exact JSONL lines. Different provenance variants sharing an event
ID survive storage and migration. Existing logical ID deduplication, redaction
preference, ordering, links and re-anchor traversal remain in the store layer.
A native merge can retain duplicate batches with overlapping records; exact
line union makes their reads converge. Missing or corrupt fragments fail
closed. As with legacy notes, removing an entire record or batch with external
Git commands is a deletion; fragments cannot detect that deletion themselves.

Scoped push pins one local snapshot for reachability resolution, secret
scanning and transfer. It unions only selected logical anchors into a unique
temporary ref seeded from the advertised remote tip; a failed fetch never
means an empty remote. The temporary ref descends from the remote, not the
local notes history. The preflight enumerates every reachable blob in the
actual outgoing snapshot, including commit ancestors, and blocks blobs above
100 MiB before invoking push. Unscoped push audits and pushes the same pinned
local tip. The check conservatively includes blobs already on the remote.
Transport hook failures continue to allow code pushes under the existing
policy; the ledger remains local.

`prepareStorageMigration()` / `storage-prepare` pins and backs up the live
notes tip under `refs/annals-backups/<namespace>/<uuid>`, then builds a candidate
under `refs/notes/<namespace>-migration-<uuid>` with an independent root. It
preserves every current anchor and distinct serialized record, verifies exact
line equality after reassembly, and audits the resulting object graph. Old
snapshots remain reachable from the backup; they are deliberately excluded
from the candidate's ancestry. Historical versions are retained locally by
the backup rather than resurrected into the current record set. A changed
source causes refusal; the source, backup and candidate are retained for
inspection. The routine never replaces the active ref or pushes anything.

Promotion requires an operator-approved compare-and-swap after capture and
sync writers are stopped. Preserve and reconcile pending records, allowlists,
known-secret state and producer cursors; migration does not modify them.
Back up all affected incoming/staging refs too. Reconcile their current
records using the new reader before removing stale staging refs: native merge
of old history after promotion can restore oversized ancestors. Other clones
must upgrade and follow the same recovery rules. Never push backup refs,
`--mirror`, or `--all` refs as part of this recovery.

If only local history is oversized, a normal scoped push can publish bounded
current records on top of the clean remote tip without force. A contaminated
remote history requires a separate reviewed remote-root migration, explicit
approval for history rewriting, a lease on the observed remote tip, and
coordinated recovery in every clone. Preparation does not authorize that step.
See the [incident recovery procedure](oversized-notes-recovery.md).

LFS is not automatically applied to blobs written with Git plumbing or notes.
Adopting it would require explicit object upload, download, authentication,
missing-object handling and independent retention guarantees. A pointer in a
note would no longer make the record bytes reachable and transferable through
that notes ref alone. Bounded in-ref fragments preserve the present contract.

Limits remain: the total ledger and notes history are unbounded, base64 adds
roughly one third to fragment payload sizes, and repacking can retain old
bounded blobs in history. Reads and migrations materialize records in memory;
they are not streaming. The existing Git subprocess reader has a 512 MiB
per-command output limit, so larger legacy blobs require separate streaming
recovery tooling. This implementation addresses the observed ~301 MiB note,
not arbitrary-size legacy objects. Hosts may impose repository, push, object
count or rate limits beyond the per-blob bound. Native merges involving two unmigrated legacy notes can still produce an
oversized legacy blob; scoped rewriting or a prepared migration is needed,
and the preflight prevents a doomed unscoped push. Older Annals readers and
writers cannot safely operate on fragment notes; upgrade consumers together.
