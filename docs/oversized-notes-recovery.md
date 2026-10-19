# Oversized notes recovery

This procedure addresses the conversation-ledger repository at
`/Users/evintunador/repos/evintunador/conversation-ledger`. It does not apply a
migration automatically. The Annals task checkout is
`/Users/evintunador/repos/evintunador/annals-worktrees/bounded-notes`.

## Evidence

Object-size and newline-length measurements on 2026-10-19 found:

- Anchor `65aaa5dd9008140720763566da9a43f097914b84` holds a 315,810,547-byte
  current note with 46,643 lines.
- Its largest line is 4,530,741 bytes. Five lines exceed 4 MiB; none exceeds
  100 MiB. Cumulative growth is the primary cause.
- Two oversized blobs are reachable from the live notes ref: the current
  `122fe41f7e7bd0e1033a856a5f5c9a7e77fc440c` (315,810,547 bytes) and historical
  `d32d18da5a778ba441495d47014485681ca4da1b` (315,593,876 bytes, 46,600 lines).
- The active ledger has 64 anchors. Other retained notes refs also exist;
  their names alone do not establish whether their records are superseded.

These measurements decoded no JSON content and printed no conversation text,
secret findings, review decisions or surrounding context. Subsequent capture
can change these numbers. Re-audit before approving a promotion.

GitHub blocks blobs above 100 MiB; compression does not bypass this policy.
See [GitHub's large-file documentation](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).
LFS stores bytes outside Git behind pointer files; ordinary notes writes do
not automatically upload or hydrate LFS objects. See [GitHub's LFS documentation](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage)
and the [storage design](architecture.md#bounded-notes-and-recovery).

## Prepared candidate for operator review

Preparation completed without promoting or pushing any existing ref:

| Item | Verified value |
| --- | --- |
| Source tip | `dfcfc2d2dce0d8e33c92213a3f5cf45053389784` |
| Main backup | `refs/annals-backups/conversation-ledger/d9d9207d-1844-496a-a3a1-f602935ade3b` |
| Candidate ref | `refs/notes/conversation-ledger-migration-d9d9207d-1844-496a-a3a1-f602935ade3b` |
| Candidate tip | `b74d8fc49fd95a17f002eaeac8dbb0b76488db22` |
| Preserved current records | 64 anchors; 66,305 distinct serialized lines |
| Largest reachable candidate blob | 1,398,282 bytes; no blob exceeds the 4 MiB bound |
| Observed remote tip | `30f2843971f34703eb9683b2f7b3ed80712fe8e5`; no blob above 100 MiB |

All five existing notes refs were also backed up under
`refs/annals-backups/incident-f8b3f89b-8f41-4aa1-a380-08ebe7e393a2/`, retaining
their original suffixes. Both incoming refs have the observed remote tip;
each contains 19,662 serialized lines, all present byte-for-byte at the same
anchors in the source. Their backups preserve that state. No records unique
to either incoming ref need to be imported for this candidate. Legacy and
previous migration refs remain untouched and backed up; they are not sync
inputs and must remain local.

After upgrading all consumers, stopping writers, rechecking these tips and
obtaining approval, the concrete local promotion is:

```sh
git update-ref refs/notes/conversation-ledger \
  b74d8fc49fd95a17f002eaeac8dbb0b76488db22 \
  dfcfc2d2dce0d8e33c92213a3f5cf45053389784
```

The proposed individually approved staging cleanup is:

```sh
git update-ref -d refs/notes/cledger-incoming \
  30f2843971f34703eb9683b2f7b3ed80712fe8e5
git update-ref -d refs/notes/conversation-ledger-incoming \
  30f2843971f34703eb9683b2f7b3ed80712fe8e5
```

These commands have **not** been executed. The remote is clean, so a subsequent
normal scoped sync can fast-forward it without a force-push. Recheck its tip
and rerun the producer's scan gate first. Do not publish the candidate ref
itself or use it for an unscoped push; it has an independent root and the normal
scoped sync supplies the correct remote parent. The metadata-only preparation
receipt is also saved locally at `/private/tmp/annals-recovery-receipt.json`.

## Prepare without replacing existing refs

1. Build this Annals revision using `npm ci` and `npm run check` in its task
   checkout. Upgrade the producer and every reader/writer/hook installation
   to this revision before any fragment notes become active. The existing
   cledger namespace must remain unchanged, including its allowlist and
   known-secret state under `.git/conversation-ledger`. Do not reinstall or
   reset that state. A passed human review is not a reason to bypass scanning.
2. Pause capture and sync processes for the recovery window. Keep code work
   available; avoid hooks that would race notes maintenance. Inspect only
   refs, object sizes and aggregate counts in an agent session.
3. Use a profile matching the producer's existing namespace, from the affected
   repository. Set `ANNALS_BUILD` to the absolute task checkout above:

   ```sh
   node "$ANNALS_BUILD/dist/cli.js" profile add recovery --local \
     --namespace conversation-ledger --incoming cledger-incoming \
     --internal-env CLEDGER_INTERNAL --state-dir conversation-ledger \
     --config-file .cledger.json --user-config-dir cledger --cli-name cledger
   node "$ANNALS_BUILD/dist/cli.js" --profile recovery records storage-audit
   ```

4. Back up the main and each existing incoming/staging/legacy ref under a
   unique `refs/annals-backups/...` name, using `git update-ref BACKUP OLD_TIP
   ZERO_OID` to prevent overwriting an existing backup. Record exact old/new
   tips and ref names in a metadata-only receipt. In this repository reconcile
   at least `refs/notes/cledger-incoming`,
   `refs/notes/conversation-ledger-incoming`, and any leftover push-temp ref;
   preserve `conversation-ledger-ev1` and any prior migration ref too. Do not
   delete them based on their names. If desired, create an offline bundle
   containing only these explicitly selected refs, protect it as conversation
   data, and keep it outside this checkout. Never attach that bundle to a PR.
5. Build the candidate:

   ```sh
   node "$ANNALS_BUILD/dist/cli.js" --profile recovery records storage-prepare
   ```

   This also backs up the pinned main ref before constructing anything. Save
   the returned `source`, `backup`, `candidate`, `tip`, `anchors`, and `events`.
   It verifies exact current serialized lines at each anchor, not merely
   IDs/counts, and audits the candidate's complete reachable object graph.
   Preparation does not push, promote, remove refs, change event IDs, mutate
   reviews, or read/update pending/allowlist/cursor files. A failure leaves the
   original ref intact. Partial candidates and backups are local recovery
   artifacts; do not push them.

6. Compare staged refs' current records against the main snapshot using the
   upgraded library, reporting aggregate differences only. If staging holds
   unique records, reconcile them through the producer before preparing a new
   candidate. A staging copy of a pre-redaction record must not supersede a
   reviewed rewrite. Do not publish historical snapshots as fresh records.
   The backup preserves them for recovery without resurrecting them. If a
   push-time scan finds anything, stop: a human must use `cledger review` in a
   plain terminal. Do not print or inspect findings in the agent session.

## Approval boundary and promotion

Present the receipt, aggregate verification, affected staging refs, installed
consumer revisions and remote tip to the operator. Obtain explicit approval
before replacing the active notes ref, removing staging refs, rewriting any
shared history, or force-pushing. The following are reviewable instructions,
not authorization to execute them.

For local promotion, while writers are stopped, substitute the receipt's
literal full OIDs and refs into:

```sh
git update-ref refs/notes/conversation-ledger CANDIDATE_TIP SOURCE_TIP
```

The expected old tip prevents overwriting intervening capture. If it fails,
stop and prepare again from the new source. Back up and reconcile each stale
incoming ref before an individually approved compare-and-delete:

```sh
git update-ref -d STAGING_REF OBSERVED_STAGING_TIP
```

Do not remove pending records or review state. A pending queue will drain on
the next successful append. Do not expire reflogs or run a destructive GC.
The backup refs intentionally keep old oversized blobs reachable locally;
Git transfers only objects reachable from explicitly pushed refs, not all
objects in the object database or reflogs.

## Publish and coordinate clones

Fetch/inspect the remote ledger into a backed-up staging ref and audit its
reachable graph first. If it has no oversized history, use the upgraded
producer's normal **scoped** `cledger sync` on the intended branch. It scans
using the existing review state, packs the selected anchors, and creates a
fast-forward descendant of the remote ledger. Do not add `--all`: an old
local/incoming parent can still contaminate that history. Other anchors stay
local until their branches are intentionally synced. Successful code pushes
are unaffected by a held ledger.

Every other clone must upgrade before reading/writing fragments. Back up its
ledger and staging refs; reconcile unsynced current records before replacing
or merging anything. Native merging of stale history can restore oversized
ancestors locally; rerun candidate preparation after reconciliation when a
clean local history is needed. Backup refs must never be used as sync inputs.

If the remote itself has oversized history, normal scoped push cannot remove
it: the scoped snapshot inherits that history. Stop and prepare a separate
reviewed candidate that includes every remote current record plus approved
local records for the intended scope. Obtain approval for the concrete
shared-history rewrite and clone coordination. Only then use an explicitly
leased push of that candidate:

```sh
git push --force-with-lease=refs/notes/conversation-ledger:OBSERVED_REMOTE_TIP \
  origin APPROVED_CANDIDATE_REF:refs/notes/conversation-ledger
```

Run the producer's scan gate for this exact candidate first; a raw push alone
is not a replacement for the review/scan workflow. Never use an unleased force
push, `--mirror`, or a broad ref push. This PR does not perform such a rewrite.

## Rollback and limits

Before publishing, an approved local rollback is a compare-and-swap from the
observed candidate tip back to the recorded backup tip. If capture has resumed,
back up and reconcile its newer records first. After publishing fragments,
rolling back the remote would be another shared-history change requiring its
own approval and reconciliation; prefer fixing forward.

Physical blobs are bounded, not total history or ledger size. Fragment base64
adds about one third to stored payloads. Repacking retains historical bounded
blobs and reads require memory proportional to the ledger. Legacy blobs above
the Git wrapper's 512 MiB read limit need additional streaming recovery tools.
The observed 315,810,547-byte note fits this reader limit. Other host limits
still apply. Offline backups may contain pre-redaction material: protect them
and never push them with code or attach them to diagnostics.
