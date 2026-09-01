# Working in annals

## Writing secret-shaped fixtures (read before adding any test or doc example)

annals owns the secret-redaction stack, so its tests and docs constantly need
fake credentials — and conversations about this repo are captured by cledger,
so every fake credential you type becomes ledger content that the pre-push
scan will flag and a human will have to review. Author fixtures so they never
enter that queue:

- **Any keyword-shaped fake** (`password=...`, `api_key: ...`, URL
  credentials, bearer tokens): put an uppercase marker inside the value —
  `FAKE`, `EXAMPLE`, `PLACEHOLDER`, `DUMMY`, `NOTREAL`, or `TESTONLY`.
- **Format-valid tokens** (a real-looking `ghp_…`/`sk-ant-…` that must
  exercise a capture rule): never write one whole — not in a file, not in
  the chat, not in a commit message. Store it split as `secret_parts` in
  `src/test/fixtures/secret-corpus.json` and let the test reassemble it
  (see `src/test/secret-corpus.test.ts`). Markers do not exempt capture-tier
  formats, deliberately.
- Existing helpers already follow this; extend them rather than minting
  values inline (`fakeSecret(...)` in `src/test/redact.test.ts`, the corpus
  file for anything new).

If a scan finding appears when pushing: **stop and tell the human.** Do not
read flagged content into the conversation — that re-seeds the finding. The
human clears the queue with `cledger review` in a plain terminal.

## Layering rule

annals never interprets `content` and never learns a producer's vocabulary.
If a change needs annals to know what a conversation, a continuation, or an
intent is, the change belongs in that producer's package, not here.
