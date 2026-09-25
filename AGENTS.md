# Working in annals

## Architectural boundary

annals owns the storage envelope and its mechanics: identity, validation,
deduplication, ordering, links, commit anchoring, re-anchoring, redaction,
secret scanning, and git-notes transport. It never interprets producer-owned
`content` or `meta`. Vocabulary-specific behavior belongs in the producer.
The one existing compatibility exception is the redaction exemption for a
`reasoning` record's `encrypted_content` leaf; treat it as narrow security
debt, not a precedent for adding more producer kinds to store code.

## Documentation contract

Treat documentation as part of the change, not as follow-up work. Keep these
sources synchronized:

| When changing | Update |
|---|---|
| Public exports or the event envelope | `README.md` and `docs/architecture.md` |
| Configuration fields or defaults | `docs/configuration.md` |
| Install, build, test, or release commands | `README.md` and `docs/development.md` |
| Redaction, scanning, transport, or re-anchoring behavior | `docs/architecture.md` |
| CLI commands or flags | `README.md` |
| Downstream dispatcher, profiles, or command conventions | `docs/downstream-integration.md` |

Use durable links to the documents above instead of references to temporary
plans or WIP files. Examples should use annals terminology unless they are
explicitly explaining compatibility with a particular downstream producer.

Before committing, run:

```sh
npm run check
```

`npm run docs:check` provides link, anchor, terminology, and required-section
sentinels. It cannot prove semantic agreement. Review still needs to verify
that prose describes behavior and tradeoffs rather than merely naming current
symbols. This file makes that responsibility visible to coding agents at the
start of a task, and CI runs it across every supported Node.js release line.

## Secret-shaped fixtures

Never write a format-valid fake credential whole in source, documentation,
chat, or a commit message. Store detector-shaped values split as
`secret_parts` in `src/test/fixtures/secret-corpus.json` and reassemble them in
the test. For keyword-shaped examples, include an uppercase marker such as
`FAKE`, `EXAMPLE`, `PLACEHOLDER`, `DUMMY`, `NOTREAL`, or `TESTONLY` in the
value. See `CLAUDE.md` for the full rationale and review procedure.

If a push-time scan reports a finding, stop and ask a human to use the owning
producer's review workflow in a plain terminal. The bare annals CLI only
provides transport commands. Do not print or inspect flagged content in an
agent session.
