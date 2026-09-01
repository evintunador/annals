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
  actor: { type, id?, display? },  // who: "human" | "agent" | "system"
  producer: { tool, version?, source?, source_version?, model?, provider?, session_id? },
  stream?: { id, seq, parent? },   // grouping + ordering, e.g. a conversation
  links?: [{ rel, target }],       // typed edges to other records
  content: unknown,                // never interpreted by annals
  media_type?, raw?, resolved?, redactions?, context?
}
```

Identity (what makes two writes the same record) is the source-determined
subset: schema, kind, occurred_at, actor type+id, producer source+session_id,
stream, media_type, content, links. Volatile provenance — recorded_at,
context, raw, resolved, producer tool/version/model — is excluded so a rescan
under a different HEAD or tool version dedups instead of duplicating. Note
the consequence: two records differing *only* by `producer.tool` dedup to
one. Byte-identical content is the same fact.

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

## Size policy

Records carry pointers, digests, and spans — never large artifacts. Git notes
replicate to every clone that fetches the ref; a checkpoint, a media file, or
a whole database belongs elsewhere, referenced by path + hash (see
`resolved`). The redaction stack walks `content` and `raw.data` only, which
is the second reason not to smuggle payloads into other fields.

## Prior art

[git-bug's `entity/dag`](https://github.com/git-bug/git-bug) (Go) is the
closest relative — replicated append-only operations in git refs, id = hash
of the serialized op, per-type `{namespace, typename, formatVersion}`; its
identification triple matches annals' `(producer.tool, kind,
producer.version)`. Dolt's git-remote support solves an overlapping problem
with a versioned SQL database; it lacks commit anchoring, which is the
mechanism everything here hangs off.
