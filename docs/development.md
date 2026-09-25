# Development and source installation

annals currently has no public npm release. Until its API has more downstream
usage, consume it from a checkout or a pinned git commit rather than assuming
semver stability.

## Requirements

- Node.js 20 or newer
- npm
- git
- optional: `gitleaks`, to run the external secret-corpus oracle

## Build and test

```sh
git clone https://github.com/evintunador/annals.git
cd annals
npm ci
npm run docs:check
npm test
```

`npm test` performs a clean TypeScript build before running Node's test runner.
When `gitleaks` is on `PATH`, the suite also verifies that the redacted fixture
corpus is clean according to that scanner.

## Consume a local checkout

Build a tarball, then install that immutable artifact in the downstream
project:

```sh
cd /path/to/annals
npm ci
npm test
npm pack

cd /path/to/downstream-project
npm install /path/to/annals/annals-0.1.0.tgz
```

For active development across both repositories, `npm install
/path/to/annals` also works. Re-run `npm run build` in annals after changes.

To install directly from GitHub, pin a full commit SHA rather than `main`:

```sh
npm install github:evintunador/annals#FULL_COMMIT_SHA
```

The repository's `prepare` script builds `dist` during that installation.
Commit pinning matters because the package is intentionally pre-release and
does not yet promise a stable public API.

## Project checks

- `npm run build` compiles TypeScript and makes the CLI executable.
- `npm run docs:check` verifies internal documentation links and documentation
  contract sentinels.
- `npm run check` runs documentation checks and the complete test suite.
- `npm test` builds and runs the complete test suite.
- `npm pack --dry-run` previews the eventual published package.

## Release status

The package metadata is present to exercise the real package shape, but there
is deliberately no npm publication, git tag, or GitHub release yet. A future
release should only happen after downstream vocabularies have exercised the
namespace, identity, and migration contracts.
