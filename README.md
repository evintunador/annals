# annals

Append-only records anchored to git commits: typed, linkable, redacted on
write, synced through git notes. annals is the storage layer extracted from
[conversation-ledger](https://github.com/evintunador/conversation-ledger)
(cledger), which now sits on top of it as one vocabulary among several.

A record ("event") is a JSON object stored one-per-line in a git note attached
to the commit that was `HEAD` when it happened. Because storage is git notes
under a dedicated ref, records travel with `git push`/`git fetch` (a pre-push
hook and a fetch refspec are installed on first append), survive clones, and
scope naturally: "records reachable from this branch" is a ref walk.

## What annals owns, and what it refuses to own

annals owns **facts about records**: identity, dedup, ordering, links,
commit anchoring, re-anchoring after squash merges, redaction on write, the
pre-push secret scan, and transport. It never interprets `content` — what a
record *means* belongs to the tool that wrote it (`producer.tool`), which
owns that vocabulary, its versioning, and its reader.

A third-party record kind is identified by the pair **`(producer.tool,
kind)`**, never by `kind` alone. `producer.version` names the vocabulary
revision. annals validates the envelope only; producers validate their own
payloads in their own packages.

## The envelope

```ts
{
  id: "ev2-<sha256 of the identity subset>",
  schema: "annals/v1",
  kind: string,                    // open; owned by (producer.tool, kind)
  occurred_at, recorded_at: string // ISO 8601; recorded_at not in identity
  producer: { tool, version? },    // who wrote it; (tool, kind) names a vocabulary
  meta?: { ... },                  // producer-owned metadata, uninterpreted
  stream?: { id, seq, parent? },   // grouping + ordering, e.g. a conversation
  links?: [{ rel, target }],       // typed edges to other records
  content: unknown,                // never interpreted by annals
  media_type?, raw?, resolved?, redactions?, context?
}
```

The envelope carries no downstream concepts: no actor, no model, no session.
A vocabulary that wants them (cledger records who spoke and which model
served a turn) puts them in `meta`. Each field answers exactly two
store-level questions — is it in the id, and does redaction walk it:

| field | in identity | redaction-walked |
|---|---|---|
| kind, occurred_at, stream, media_type, content, links | yes | content yes |
| meta | **no** | **no** — provenance only, never free text |
| raw | no | yes (`raw.data`) |
| producer, context, recorded_at, redactions | no | no |
| resolved | no | **no** — never put payloads here |

`meta` being identity-excluded is the point: provenance can be added or
enriched later without the same fact getting a new id. It is not
redaction-walked — the contract is structured provenance only (ids, names,
labels); anything that could carry source text or a secret belongs in
`content`/`raw`. This matches the pre-extraction behavior (actor/producer
were never walked) and keeps UUID-heavy metadata out of the entropy scan's
false-positive path. A vocabulary that
needs one of its facts *in* identity puts it in `content`. Note the standing
consequence: two records differing only by producer or meta dedup to one —
byte-identical content is the same fact.

## Namespaces

Every operation takes a `Ledger` — a repo handle plus a namespace — from
`openLedger(repo, opts)`. A namespace picks the notes ref
(`refs/notes/<name>`), the state directory under `.git`, the config file
name, and the CLI the pre-push hook invokes. Producers that want their own
independently-pushable, independently-wipeable ref (a derived layer that must
be rebuildable, say) open their own namespace; producers extending an
existing vocabulary write into that vocabulary's namespace through its
owner's API. cledger uses `{ name: "conversation-ledger", configFile: ".cledger.json" }`.

Two namespaces in one repo chain two hook blocks in `pre-push`. Git feeds
that script its stdin once, so only the first block sees the pushed-ref
list; later blocks degrade to `HEAD` scope — records still push, scoped to
the checked-out branch. And a custom namespace's hook only fires if its
`cliName` is on PATH or `hookInvocation` was given; otherwise its owner
syncs through the library.

## Sync scan reports

`annals sync` and the pre-push transport scan new records before sharing
them. A finding blocks the records push (and, with `transport.strict`, the
code push) but prints only aggregate counts and a safe handoff by default.
It does not print fingerprints, event ids, coordinates, matched text, or
surrounding context.

A human or CI job can deliberately request the coordinate-only report:

```sh
annals sync origin --report
```

The report includes fingerprints and event/path coordinates for remediation,
but never matched text or context. Coding agents should not request the report
or inspect the flagged events; hand the concise message to a human working in
a plain terminal. `--report` changes presentation only: findings still block
the same push and produce the same nonzero exit status.

## Size policy

Records carry pointers, digests, and spans — never large artifacts. Git notes
replicate to every clone that fetches the ref; a checkpoint, a media file, or
a whole database belongs elsewhere, referenced by path + hash (see
`resolved`). The redaction stack walks `content` and `raw.data` only, which
is the second reason not to smuggle payloads into other fields. Enforced
softly: an event serializing over `limits.warnEventBytes` (default 5MB)
warns on stderr but still appends — capture must never drop records on size
alone; set `limits.maxEventBytes` to opt into hard refusal for a producer
that would rather fail loudly, such as a derived layer.

## Identity records (optional pattern)

The envelope has no actor field, and attribution does not need one: an
identity can be a record like any other — its own kind, its own producer —
and a record claims authorship with a link (`{ rel: "authored_by", target:
<identity record id> }`). That is how git-bug stores identities, versioned
and signable, in the same store as its bugs. Nothing in annals mandates
this; a vocabulary can just as well denormalize `meta.actor` onto every
record (cledger does today) and adopt identity records later without a
schema change — both are producer-space conventions.

## Prior art

[git-bug's `entity/dag`](https://github.com/git-bug/git-bug) (Go) is the
closest relative — replicated append-only operations in git refs, id = hash
of the serialized op, per-type `{namespace, typename, formatVersion}`; its
identification triple matches annals' `(producer.tool, kind,
producer.version)`. Dolt's git-remote support solves an overlapping problem
with a versioned SQL database; it lacks commit anchoring, which is the
mechanism everything here hangs off.
