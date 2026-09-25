# VCS compatibility investigation

Status: exploratory findings, not a support commitment. Investigated on
2026-09-24 against annals commit `05ea04b685ac23d27544cf7f4b591eaba7400c4f`
and the official Jujutsu 0.45.1 macOS ARM64 binary. No production behavior
was changed. See [architecture](architecture.md) for the current contract
and [downstream integration](downstream-integration.md) for producer ownership.

## Recommendation

Decision on 2026-09-25: defer this work. Retain the findings and recommendations
below for future consideration; neither the API preparation nor a VCS
integration is a current publication prerequisite.

The clarified goal on 2026-09-25 is to preserve future VCS support before
publication, without building that support now. There is no current consumer
request. Future support should let downstream producers use annals without
knowing the VCS, and ordinary users should not need routine manual sync.
Security remediation is an acceptable manual intervention.

Recommend a small producer API boundary before publication, backed only by
the existing Git implementation initially. Do not extract a generic backend
plugin interface or build another storage implementation yet. The audit below
finds public coupling worth containing, but no requirement to replace the
event envelope or existing Git notes to preserve a future additive path.

The earlier explicit-sync experiment establishes that transport can work;
explicit sync alone would not meet the clarified product requirement.

## Pre-publication compatibility audit

The distinction is between changing annals internally, breaking callers, and
invalidating persisted records. These are different costs. A new backend
could require substantial implementation work without forcing either of the
latter two changes.

| Existing contract | Future risk | Compatible evolution path |
| --- | --- | --- |
| Event IDs exclude context and physical note location | Low VCS coupling for ordinary producer records | Preserve the identity algorithm and envelope; add optional structured context if necessary. |
| `SCHEMA_VERSION` participates in event identity | A blanket schema bump changes newly computed IDs, even for unchanged source facts | Avoid a schema bump merely to introduce another storage implementation. Preserve old readers and identity rules deliberately. |
| `Ledger extends RepoInfo`, requiring `gitDir` and `commonDir` | A native backend cannot truthfully satisfy this handle; callers may construct or inspect it | Introduce a separate opaque producer handle. Keep existing Git handles and entrypoints working if already published. |
| `findRepo()` is Git discovery; `openLedger()` is synchronous | Broadening return types or making the existing opener asynchronous can break callers | Add an asynchronous discover-and-open producer entrypoint; retain the existing Git API. |
| Root exports include raw Git operations, note helpers, forge helpers, and hook machinery | Every exported helper can become a lasting compatibility obligation | Inventory exports before release; deliberately separate the recommended producer surface from advanced Git APIs. Moving/removing published root exports is itself breaking. |
| `NamespaceConfig` and profiles contain notes-ref and hook details | Producers and persisted profiles know the Git transport layout | Producer setup should need a logical namespace and producer configuration; retain Git settings in a Git-specific layer and read legacy profiles. |
| `context.head` is documented as a Git SHA | Reinterpreting it as an arbitrary logical change ID would silently change meaning | Retain its Git meaning. Add optional, explicitly typed revision context if another backend needs it; context is excluded from event identity. |
| Explicit anchors and revision selectors are strings; read/sync defaults mean Git `HEAD` | Git syntax and visibility semantics can leak into producer code | Give the new producer surface a documented default of records associated with current work. Keep explicit Git selectors on the Git surface; introduce typed selectors only when needed. |
| `parseReAnchor()` accepts exactly 40 hexadecimal characters | Existing mapping parsing cannot represent arbitrary revision IDs, or even Git SHA-256 IDs | Preserve old mapping interpretation; extend validation for a concrete supported format or add a new versioned bookkeeping shape with an appropriate reader. Do not rewrite historical mapping records. |
| Re-anchor options enumerate tree, patch-id, and manual methods | A native predecessor relation is not represented in the current typed constructor | Add a method or a new constructor when implementing that relation. Existing records can retain their methods. |
| State/configuration/review helpers accept Git handles and use `commonDir` | A thin opener alone would leave producer state and maintenance tied to Git | Include shared local state access and the maintenance dispatcher in the boundary audit. Preserve the privacy and workspace-sharing properties of those paths. |
| Hook/fetch options and strict transport describe Git behavior | Automatic background sync cannot necessarily stop a native code push | Preserve Git option meanings. Model automation and code-push interception separately when another integration exists. |

No major version is inherently required to add future VCS support: new
entrypoints, new handles, and internal dispatch can coexist with the old Git
API. However, promising that the current structural `Ledger` type itself
will later become backend-neutral without caller changes would be unsound.
Compatibility can require keeping the old Git surface indefinitely. An API
boundary established before adoption reduces that obligation and lets future
producer integrations remain unchanged.

Likewise, extensible JSON does not guarantee old software understands new
backend semantics. Optional provenance can be additive, while new mapping
records require capable readers. Preserve existing Git behavior and data;
do not claim that an older annals release can operate a newly introduced VCS.

### Recommended preparation

Before recommending the first public producer integration:

1. Define a narrow asynchronous entrypoint that discovers the workspace and
   opens the producer namespace, returning a handle callers do not construct
   or inspect for VCS paths. The exact name and method signatures remain a
   design task, not a new API promised by this document.
2. Route normal capture, read, maintenance, and automatic transport setup
   through that handle. Expose the local state and identity operations real
   producers need without requiring raw Git calls. Keep advanced Git
   operations explicitly separate.
3. Exercise the surface with one real downstream producer, including its
   cursor paths, capture attribution, and maintenance commands. The current
   investigation audited annals only; it has not established whether cledger
   or turnbridge has additional independent Git assumptions.
4. Preserve event identity, namespace names, existing notes, and current Git
   sharing scope. Keep backend interfaces private so a real second backend
   can shape them later.
5. Document the product-level behavior: records remain associated with work
   through supported ordinary rewrites; routine sharing is automatic and
   scoped; security findings hold records for review. Do not make a universal
   claim about arbitrary VCS operations.

An implementation should demonstrate one unchanged producer capture/read
flow and its maintenance dispatcher against the existing Git backend, plus
unchanged Git record IDs and transport scope. It need not install another VCS
or simulate support with a dummy backend to justify this boundary.

### Seamless transport is a separate feasibility constraint

The Jujutsu probe bypassed the Git pre-push hook, consistent with upstream's
[documented lack of Git hook support](https://docs.jj-vcs.dev/latest/git-compatibility/).
Changing annals' storage interface does not create a native command callback.
A future integration needs a supported native callback, an automatically
invoked producer integration, or another accepted automatic mechanism. A
background worker may provide eventual records sync, but cannot generally
prevent a code push that has already completed. It would also need to learn
the actual published scope and destination rather than share all local work.

Consequently, ordinary automatic delivery and strict interception of code
pushes are different requirements. The maintainer has requested automatic
delivery; whether code and records must share an interceptable push boundary
is still open. This affects later feasibility, not the current record format.
The existing Git behavior can remain stable in either case.

## Experiment and results

Built annals with `npm run build` and exercised its public library against
synthetic repositories and a local bare Git remote. Git global/system config
was disabled for the probes; Jujutsu config and XDG configuration lived in
the scratch directory. No real repository was converted and no remote
service received test records. The downloaded binary's SHA-256 matched the
digest published in the official GitHub release metadata.

| Probe | Observed result |
| --- | --- |
| Colocated repository discovery | `findRepo()` succeeded. |
| Empty repository | Git `HEAD` was unborn even though Jujutsu had a working-copy commit. Capture entered annals' pending queue. |
| Initial `jj describe`, then `jj new` | Describe left Git `HEAD` unborn. New advanced Git `HEAD` to the working-copy parent; the next append drained pending records. |
| Default capture | Anchored to Git `HEAD`, equal to `@-` in the tested ordinary single-parent workspace, rather than `@`. |
| `jj describe -r @-` | Two records disappeared from default reads; both remained readable through their old note and unscoped reads. |
| Explicit capture against `@` | The record was readable when explicitly scoped to that commit. A subsequent file edit and Jujutsu snapshot rewrote it; the new revision no longer exposed the record. |
| `jj rebase` of a bookmarked change | The rewritten feature exposed zero records, while one remained in the unscoped ledger. |
| Existing rewrite detector | Explicit runs targeting `HEAD` found no mappings for the tested describe or rebase cases. |
| `jj abandon` | The explicitly captured working-copy record remained stored but was absent from default reads. |
| New work from a shared base | Default capture anchored to the shared base, so that anchor cannot distinguish sibling working-copy changes. |
| Non-colocated Git-backed repository | `findRepo()` returned null. |
| `jj git push` | A sentinel Git pre-push hook did not run; no notes ref reached the remote. |
| Explicit annals push and fetch | A record arrived and became visible in a second Jujutsu clone after an explicit notes fetch. |
| Clone before explicit notes fetch | Code arrived; annals read zero records. The bare remote's HEAD was configured to the pushed main branch. |
| `jj git fetch` after annals installed its notes refspec | A second record did not arrive. A subsequent explicit annals fetch made both records visible. |
| Concurrent capture and Jujutsu describe | A 20-iteration probe stopped on iteration 15 when Jujutsu failed to acquire the Git index lock. Inspection found 14 records whose captured `context.head` differed from their note anchor. |

These are targeted probes, not a compatibility certification. Concurrent
failure frequency is unknown. The index failure is consistent with annals'
capture-time `git status` refreshing the index; the precise lock owner was
not instrumented. Conflicted working copies, multi-parent changes, workspace
sharing, divergence, split/squash semantics, undo/restore, garbage collection,
remote authentication, and other OS or Jujutsu versions remain untested.

To reproduce the essential visibility failure, initialize a colocated
workspace, write a file, describe the working-copy change, and run `jj new`.
Open an annals ledger and append a synthetic record. Run
`jj describe -r @- -m rewritten`, then compare `readEvents(ledger)` with
`readEvents(ledger, { reachableFrom: null })`. The latter retains the record.
Run `runReAnchor(ledger, { target: "HEAD", apply: false })` to inspect the
existing detector's result.

## Why the current implementation behaves this way

- `src/git.ts` discovers repositories using Git and resolves the current
  anchor from Git `HEAD`.
- `src/store.ts` captures context before acquiring its namespace writer
  lock, then resolves `HEAD` again inside the lock. External rewrites can
  change the anchor between those operations. The lock only coordinates
  annals writers.
- Default reads and sync scopes use Git `HEAD` ancestry. Using an explicit
  working-copy commit fixes a single capture's location, but does not follow
  the next rewrite or change default read/sync scope.
- `src/reanchor.ts` searches local Git branches for exact tree or patch
  matches on a target's first-parent history. It does not consume Jujutsu
  change identity or predecessor history. Automatic detection is additionally
  gated by movement of the default rewrite target.
- `src/transport.ts` installs Git hooks and a notes fetch refspec. The probes
  show neither provides automatic notes transport through the tested native
  Jujutsu push/fetch commands.
- The library already accepts explicit anchors, read revisions, and sync
  scopes. The current sync CLI exposes default HEAD scope or `--all`, not an
  arbitrary selected revision. A wrapper pushing a different bookmark needs
  to resolve and pass the actual outgoing scope through the library or a
  future CLI extension. `--all` would broaden sharing and is not a substitute.

## Product choices

The maintainer clarified that there is no immediate adopter, that future
support should be transparent to downstream producers and end users, and
that routine manual synchronization is unacceptable. Engineering time is
available to answer pre-publication architecture questions.

The question about following revisions concerns ordinary editing and
rewriting, not migration from one VCS to another. The natural product default
is to keep relevant records visible as work evolves while retaining capture
provenance. Exact behavior on abandon, undo, divergence, splitting, and
squashing remains to be specified for a concrete integration. Following a
change ID alone does not define all those cases. These details do not need to
be frozen in the producer API now.

If evolving changes are the intended unit, a promising design to investigate
is retaining immutable capture provenance while recording explicit successor
relationships for visibility. Jujutsu change identity can help resolve those
relationships. It should not silently replace the identity of the captured
revision, nor require interpreting producer-owned `content` or `meta`.

## Deferred integration acceptance criteria

After the API preparation above, and with a concrete Jujutsu consumer, an
integration prototype should prove:

1. One coherent capture context and anchor, with no incidental index write
   during background capture. Investigate Git optional-lock suppression and
   validation/retry around moving revisions; neither mitigation was tested here.
2. Read visibility across snapshots, describe, rebase, and new changes, with
   explicit policies for abandonment and ambiguous successors.
3. Scoped notes sync between two clones, using the actual selected outgoing
   revisions and the existing scan gate.
4. Automatic invocation of scoped transport during ordinary use, with
   security findings surfaced for review. Explicit sync remains a diagnostic
   and recovery facility; it does not satisfy the normal-use acceptance bar.

The previous two-or-three-day prototype suggestion is deferred. The immediate
engineering scope is the public API audit and producer boundary, not a
production Jujutsu integration. Stop expanding integration scope if there is
no consumer, if required automation has no acceptable invocation path, or if
the chosen visibility semantics demand a larger product redesign.

## Other VCS directions

| Direction | Assessment |
| --- | --- |
| Jujutsu colocated Git backend | First candidate if there is user demand; concrete failures and a reusable notes transport already exist. |
| Jujutsu non-colocated Git backend | A separate discovery/execution problem within Git-backed support. It is not a native non-Git backend. |
| Sapling `.git` mode | A plausible second compatibility target, but only after identifying demand. No local Sapling tests were run. `.sl` mode does not support ordinary Git commands. |
| Native non-Git Jujutsu | Poor default next prototype: upstream currently describes only its Git backend as production-ready. |
| Mercurial | A candidate if a native backend is required by a user. Changeset phases and optional evolution markers introduce visibility and successor policies, plus a new record transport. No local tests were run. |
| Fossil | Its repository-wide artifact synchronization differs from annals' scoped note sharing. Record storage and sharing policy need a separate design. No local tests were run. |
| Pijul | Changes and channel membership require revisiting ancestry-based visibility. No local tests were run. |

The proposed `RecordsBackend` interface bundles repository context, revision
semantics, record storage, and transport. The probes justify examining these
boundaries separately before fixing an interface. In particular, a flat
rewrite mapping does not specify ambiguous successors or abandonment, and a
generic push operation does not specify sharing scope or scan enforcement.

## Sources and installation cleanup

Official sources checked during the investigation:

- [Jujutsu Git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/)
- [Jujutsu concurrency](https://docs.jj-vcs.dev/latest/technical/concurrency/)
- [Jujutsu backend production status](https://github.com/jj-vcs/jj)
- [Jujutsu 0.45.1 release](https://github.com/jj-vcs/jj/releases/tag/v0.45.1)
- [Sapling Git support modes](https://sapling-scm.com/docs/git/git_support_modes/)
- [Mercurial phases](https://www.mercurial-scm.org/help/topics/phases)
- [Mercurial evolution](https://mercurial-scm.org/help/topics/evolution)
- [Fossil Git translation guide](https://fossil-scm.org/home/doc/trunk/www/gitusers.md)
- [Pijul channels](https://pijul.org/manual/workflows/channels)

Jujutsu was extracted as a standalone binary under `/tmp/annals-vcs-spike`.
The archive, binary, test configuration, probe scripts, and synthetic
repositories were confined to that directory; release metadata was stored
in `/tmp/annals-jj-release.json`. No package-manager registration, PATH edit,
or user configuration edit was required. Both temporary locations were
deleted after the investigation, including the binary and all test data.
