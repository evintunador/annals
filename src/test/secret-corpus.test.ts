import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { rulesForTier, RULESET_VERSION } from "../redact/rules.js";
import { redactText } from "../redact/apply.js";

// Load fixture from source tree (not dist) so it's available at test time
const fixtureUrl = new URL(
  "../../src/test/fixtures/secret-corpus.json",
  import.meta.url,
);
const fixtureJson = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf-8"));

interface Positive {
  rule: string;
  secret: string;
  context: string;
}

interface CorpusFixture {
  positives: Positive[];
  negatives: string[];
}

/**
 * Fixture entries store each fake secret as `secret_parts` (split mid-token)
 * with a `{SECRET}` placeholder in the context, so no literal token bytes
 * exist in the repository — otherwise secret scanners (GitHub push
 * protection, gitleaks over the source tree) flag the corpus itself.
 * Reassemble here, at test runtime only.
 */
interface StoredPositive {
  rule: string;
  secret_parts: string[];
  context: string;
}

const stored = fixtureJson as { positives: StoredPositive[]; negatives: string[] };
const corpus: CorpusFixture = {
  positives: stored.positives.map((p) => {
    const secret = p.secret_parts.join("");
    return { rule: p.rule, secret, context: p.context.split("{SECRET}").join(secret) };
  }),
  negatives: stored.negatives,
};

// Validate fixture structure
assert.ok(Array.isArray(corpus.positives), "fixture.positives must be an array");
assert.ok(Array.isArray(corpus.negatives), "fixture.negatives must be an array");

test("secret-corpus: fixture loads correctly", () => {
  assert.strictEqual(corpus.positives.length, 27, "expected 27 positive test cases");
  assert.strictEqual(corpus.negatives.length, 9, "expected 9 negative test cases");
});

test("secret-corpus: all positives are redacted", () => {
  const rules = rulesForTier("capture");
  const failures: string[] = [];

  for (const [i, positive] of corpus.positives.entries()) {
    const { text, matches } = redactText(positive.context, rules);

    // Secret must not appear verbatim in redacted output
    if (text.includes(positive.secret)) {
      failures.push(
        `${positive.rule}: secret still present in redacted text`,
      );
    }

    // Redacted output must contain redaction marker
    if (!text.includes("[REDACTED:")) {
      failures.push(
        `${positive.rule}: redacted text missing [REDACTED: marker`,
      );
    }

    // Must have at least one match with expected rule ID
    const ruleMatches = matches.filter((m) => m.rule === positive.rule);
    if (ruleMatches.length === 0) {
      failures.push(
        `positives[${i}] (${positive.rule}): no matches found for expected rule`,
      );
    }
  }

  assert.strictEqual(failures.length, 0, failures.join("\n"));
});

test("secret-corpus: all negatives pass through unchanged", () => {
  const rules = rulesForTier("capture");
  const failures: string[] = [];

  for (const negative of corpus.negatives) {
    const { text, matches } = redactText(negative, rules);

    // Output must be identical to input
    if (text !== negative) {
      failures.push(
        `negative changed: input=${negative.substring(0, 50)}..., output=${text.substring(0, 50)}...`,
      );
    }

    // Must have zero matches
    if (matches.length > 0) {
      failures.push(
        `negative matched unexpectedly: "${negative.substring(0, 50)}..." matched ${matches.length} rules`,
      );
    }
  }

  assert.strictEqual(failures.length, 0, failures.join("\n"));
});

test("secret-corpus: redaction is deterministic", () => {
  const rules = rulesForTier("capture");
  const allContexts = corpus.positives.map((p) => p.context).join("\n---\n");

  const first = redactText(allContexts, rules);
  const second = redactText(allContexts, rules);

  assert.ok(
    isDeepStrictEqual(first, second),
    "redaction result must be deterministic",
  );
  assert.ok(
    first.text === second.text,
    "redacted text must be identical across runs",
  );
  assert.ok(
    isDeepStrictEqual(first.matches, second.matches),
    "matches must be identical across runs",
  );
});

test("secret-corpus: gitleaks oracle (if available)", async (t) => {
  const gitleaksBin = process.env["GITLEAKS_BIN"] || "gitleaks";
  // Check if gitleaks is available
  const versionCheck = spawnSync(gitleaksBin, ["version"], {
    stdio: "pipe",
    encoding: "utf-8",
  });

  if (versionCheck.status !== 0) {
    assert.notStrictEqual(
      process.env["ANNALS_REQUIRE_GITLEAKS"],
      "1",
      "ANNALS_REQUIRE_GITLEAKS=1 but gitleaks is not available on PATH",
    );
    t.skip();
    return;
  }

  // Create temp directories for a detector efficacy control and redacted files.
  // Scanner output stays captured and --redact provides defense in depth: a
  // failed assertion must never print runtime-reassembled fixture values.
  const tempDir = mkdtempSync(join(tmpdir(), "secret-corpus-gitleaks-"));

  try {
    const rules = rulesForTier("capture");
    const controlDir = join(tempDir, "control");
    const redactedDir = join(tempDir, "redacted");
    mkdirSync(controlDir);
    mkdirSync(redactedDir);

    // A clean-only oracle could pass when the detector is broken or has no
    // active rules. First prove this exact binary rejects the unredacted,
    // runtime-reassembled corpus, then ask it to approve the redacted corpus.
    for (let i = 0; i < corpus.positives.length; i++) {
      const positive = corpus.positives[i];
      if (!positive) continue;
      const { text } = redactText(positive.context, rules);
      writeFileSync(join(controlDir, `positive-${i}.txt`), positive.context, "utf-8");
      writeFileSync(join(redactedDir, `positive-${i}.txt`), text, "utf-8");
    }

    const controlRun = spawnSync(gitleaksBin, [
      "detect", "--no-git", "--source", controlDir, "--exit-code", "1", "--redact", "--no-banner",
    ], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    assert.strictEqual(
      controlRun.status,
      1,
      `gitleaks positive control returned status ${String(controlRun.status)} instead of finding status 1`,
    );

    const gitleaksRun = spawnSync(gitleaksBin, [
      "detect", "--no-git", "--source", redactedDir, "--exit-code", "1", "--redact", "--no-banner",
    ], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    assert.strictEqual(
      gitleaksRun.status,
      0,
      `gitleaks redacted-output check returned status ${String(gitleaksRun.status)} instead of 0`,
    );
  } finally {
    // Clean up temp directory
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// The split scheme exists so no stored fragment is itself detectable by a
// public secret scanner. Learned the hard way: a Slack-shaped positive was
// stored as prefix+body in part 0, which is a complete match for scanners
// keyed on `xox?-` plus a dozen trailing chars — publishing this repo fired
// a GitGuardian alert on the fixture file itself. Every part must be inert
// alone, whatever it reassembles into.
const PUBLIC_DETECTOR_SHAPES = [
  /xox[bpoas]-[0-9A-Za-z-]{10,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-ant-[A-Za-z0-9-]{20,}/,
  /sk-[A-Za-z0-9]{40,}/,
  /AKIA[0-9A-Z]{16}/,
  /glpat-[A-Za-z0-9_-]{20}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

test("secret-corpus: no individual secret_part is detector-shaped on its own", () => {
  let checked = 0;
  for (const [i, entry] of stored.positives.entries()) {
    for (const [j, part] of entry.secret_parts.entries()) {
      checked++;
      for (const shape of PUBLIC_DETECTOR_SHAPES) {
        assert.ok(
          !shape.test(part),
          `positives[${i}].secret_parts[${j}] matches ${shape} by itself — re-split it`,
        );
      }
    }
  }
  assert.ok(checked > 0, "fixture must contain secret_parts for the safety guard to inspect");
});
