# Configuration

Configuration is JSON. annals loads user defaults from
`~/.config/<namespace>/config.json`, then repository settings from the
namespace's `configFile` (default `.annals.json`). Repository values win
key-by-key inside each section. `scan.allowFingerprints` is the exception: the
two arrays are combined.

Malformed files are ignored with a warning so capture is not interrupted.
Unknown properties are currently ignored; configuration is not a substitute
for producer payload validation.

## Reference

```json
{
  "enabled": true,
  "redact": {
    "capture": true,
    "env": false,
    "knownSecrets": false,
    "patterns": [
      { "id": "internal-token", "pattern": "INTERNAL_[A-Za-z0-9]{20,}" }
    ]
  },
  "scan": {
    "tier": "standard",
    "allowFingerprints": []
  },
  "limits": {
    "warnEventBytes": 5000000
  },
  "transport": {
    "hook": true,
    "strict": false,
    "fetchRefspec": true
  },
  "reanchor": {
    "auto": true,
    "forge": true
  }
}
```

### `enabled`

Defaults to `true`. Setting it to `false` makes `appendEvents()` a complete
no-op, including transport setup. Existing records remain readable.

### `redact`

- `capture` defaults to `true`. `false` disables all capture-time scrubbing:
  built-in rules, configured patterns, eligible environment values, and known
  secret matching. It does not disable the separate sync-time scan gate.
- `env` defaults to `false`. When enabled, annals exact-matches values of at
  least eight characters from eligible process variables and the repository's
  `.env`. An explicit list of routine shell-variable names and values beginning
  with `/` are excluded; variable names otherwise do not need to look secret.
- `knownSecrets` defaults to `false`. A producer's redact workflow may remember
  confirmed values as salted digests in a mode-0600 file below the common git
  directory so later captures scrub them. Each entry also retains its exact
  UTF-16 code-unit length and a four-bit salted rolling bucket used to narrow
  candidate matching; plaintext is removed. Legacy plaintext stores are read
  for compatibility and migrated on the next update. The store is local and
  never committed.
- `patterns` adds JavaScript regular expressions to the capture tier. Patterns
  are compiled with the global flag. Invalid patterns are skipped because
  configuration must not break capture.

Capture rules rewrite data silently, so custom patterns should have extremely
low false-positive rates.

### `scan`

- `tier` is `standard` by default. `paranoid` adds entropy-gated candidates;
  `off` disables the sync gate.
- `allowFingerprints` contains truncated SHA-256 fingerprints approved as
  false positives. Repository fingerprints may safely be committed: they do
  not contain the original span.

### `limits`

- `warnEventBytes` defaults to `5000000`. Larger serialized events warn but
  still append.
- `maxEventBytes` has no default. When set, larger events are rejected.

### `transport`

- `hook` defaults to `true` and controls pre-push hook installation and use.
- `fetchRefspec` defaults to `true` and controls installation of the incoming
  notes refspec.
- `strict` defaults to `false`. A scan finding normally holds back records but
  lets the code push continue. `true` aborts the entire push instead.

### `reanchor`

- `auto` defaults to `true` and permits exact tree or patch-id mappings after
  fetched history rewrites.
- `forge` defaults to `true` and lets explicit suggestion workflows query a
  supported forge through the user's authenticated CLI. Automatic reads stay
  offline.

## Namespace configuration

Library callers can pass a partial `NamespaceConfig` to `openLedger()`. A
custom namespace normally sets at least `name`, `configFile`,
`userConfigDir`, and `cliName`. It should also provide `hookInvocation`, or
ensure that `cliName` resolves on `PATH` to a CLI implementing
`transport-push`.

Existing namespaces can override `incomingName` and `internalEnvName` to keep
already-installed refspecs and recursion guards compatible.

Named CLI profiles persist the complete non-executable portion of a namespace
descriptor. Global profiles are stored in
`~/.config/annals/profiles.json`; repository-local overrides are stored below
the common Git directory and are never committed. Profiles cannot contain
`hookInvocation`; the namespace-owning CLI must install and maintain its own
hook. See [downstream CLI integration](downstream-integration.md#namespace-profiles).
