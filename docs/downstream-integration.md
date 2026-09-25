# Downstream CLI integration

annals provides record mechanics without claiming a downstream application's
top-level command vocabulary. A producer can expose the common maintenance
commands through `runRecordsCommand()` and keep application-specific commands
alongside them.

## Command naming convention

The interoperable form is:

```text
<tool> records sync
<tool> records review
<tool> records inspect --output FILE
<tool> records redact EVENT_ID --pattern REGEX
<tool> records allow FINGERPRINT
<tool> records reanchor
```

`records` is the norm because names such as `sync` and `review` are useful to
applications for unrelated jobs. A tool may also offer convenient top-level
aliases such as `<tool> review`. When it does, it should keep the canonical
`<tool> records review` form and route both spellings to the same handler.
This gives experienced users a predictable cross-tool path without taking
away a concise command where it is unambiguous.

Do not expose `<tool> annals ...`. That leaks an implementation dependency
into the user-facing vocabulary and makes a future storage change needlessly
disruptive.

## Reusable dispatcher

Open the producer's exact namespace and pass the remaining arguments and I/O
streams to the dispatcher:

```ts
import { findRepo, openLedger, runRecordsCommand } from "annals";

const repo = await findRepo(process.cwd());
if (!repo) throw new Error("run inside a git repository");

const ledger = openLedger(repo, {
  name: "example-app",
  incomingName: "example-app-incoming",
  internalEnvName: "EXAMPLE_APP_INTERNAL",
  stateDirName: "example-app",
  configFile: ".example-app.json",
  userConfigDir: "example-app",
  cliName: "example-app",
  hookInvocation: { node: process.execPath, cli: pathToThisCli },
});

process.exitCode = await runRecordsCommand({
  ledger,
  argv: process.argv.slice(recordsCommandIndex + 1),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  commandName: "example-app records",
});
```

The function never calls `process.exit()` and does not discover a repository,
namespace, arguments, or streams implicitly. It returns an exit code. This is
the single primitive both canonical commands and optional aliases should call.
Pass a complete environment (normally `process.env`); it is copied for the
invocation, used by child processes and configuration lookup, and never
mutated globally. Lower-level diagnostics are routed to the supplied stderr.

Exit codes are stable command behavior: `0` means the operation completed
without an outstanding condition, `1` means findings, a policy refusal, a
partial result, or another runtime failure, and `2` means invalid command-line
usage. Callers should forward the returned code rather than collapsing it.

The shared command set is intentionally semantic-free: sync, interactive
secret review, file-based inspection, redaction, allowlisting, re-anchoring,
and the pre-push hook entrypoint. Append/log/export behavior remains with the
vocabulary owner because it interprets producer data.

`NamespaceConfig` currently defines the hook ABI as `<cliName>
transport-push`, so a namespace-owning CLI must keep that top-level technical
entrypoint even if it also routes `<tool> records transport-push` to the same
dispatcher. It is not a user workflow and is the one deliberate exception to
putting shared operations only below `records`.

Review, inspect, redact, and allow are human-only remediation workflows. The
dispatcher refuses them when a supported coding-agent marker is present;
review additionally requires TTY stdin and stdout. Downstream wrappers should
not weaken those checks. Manual re-anchoring is also human-only because its
record is explicitly attributed as a user assertion; exact automatic
re-anchoring remains safe for an agent to request.
Bypassing the scan with `sync --no-scan` is likewise human-only when the
operation can push; fetch-only operation does not bypass a sharing gate.

## Namespace profiles

The standalone CLI can operate on a registered downstream namespace:

```text
annals profile add example \
  --namespace example-app \
  --incoming example-app-incoming \
  --internal-env EXAMPLE_APP_INTERNAL \
  --state-dir example-app \
  --config-file .example-app.json \
  --user-config-dir example-app \
  --cli-name example-app

annals --profile example sync
annals --profile example review
```

`profile add` resolves omitted conventional fields once and stores the full
descriptor; loading never infers a namespace from note refs or filesystem
names. Global profiles live in `~/.config/annals/profiles.json`. Passing
`--local` stores the descriptor beneath the repository's common Git directory,
where it overrides a global profile of the same name without becoming a
committed, remotely supplied configuration file.

Profiles deliberately exclude `hookInvocation`. Persisting and later
executing an arbitrary interpreter or script path would turn profile loading
into a code-execution boundary. The vocabulary owner's CLI remains
responsible for installing its hook with the correct executable invocation;
profiles cannot choose executable paths. Mutating maintenance commands such as
redact and applied re-anchoring append audit records through the ordinary write
path, so they may repair the owner's fetch refspec or fallback `cliName` hook.
The owner must therefore keep that shell-safe command available; profile use
does not create a second hook identity.

Programmatic profile APIs—`createNamespaceProfile()`,
`saveNamespaceProfile()`, `loadNamespaceProfile()`,
`listNamespaceProfiles()`, and `removeNamespaceProfile()`—use the same schema
and precedence rules.

## Adoption checklist

1. Preserve every legacy namespace field exactly, especially the incoming ref
   and recursion-guard environment variable.
2. Route `<tool> records ...` to `runRecordsCommand()` with the tool's ledger.
3. Keep any top-level aliases as thin routes to that same call.
4. Keep producer-specific append/read/export commands outside the dispatcher.
5. Test the canonical form, every alias, the human-only safety refusal, and
   the existing transport hook.
6. Document a complete profile-add example for people using the standalone
   annals CLI.
