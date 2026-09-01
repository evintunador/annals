/** Public library surface. Everything operates on a `Ledger` — a repo handle
 * plus a namespace — from `openLedger(findRepo(...), { ...namespace })`. */
export {
  DEFAULT_NAMESPACE,
  incomingRef,
  notesRef,
  openLedger,
  resolveNamespace,
} from "./ledger.js";
export type { Ledger, NamespaceConfig } from "./ledger.js";
export {
  appendEvents,
  captureContext,
  listAnchors,
  manualReAnchor,
  readEvents,
  readNoteEvents,
  readPending,
  redactEvent,
  RedactAfterShareError,
  runReAnchor,
  ScanBlockedError,
  sortEvents,
  sync,
  transportPush,
  parsePrePushRefs,
} from "./store.js";
export type {
  AppendResult,
  ReadOptions,
  ReAnchorRunResult,
  RedactResult,
  SyncResult,
  TransportPushResult,
} from "./store.js";
export {
  absorbIncoming,
  ensureMergeConfig,
  ensureTransport,
  hasAuthorIdentity,
  internalEnvVar,
} from "./transport.js";
export type { TransportSetup } from "./transport.js";
export {
  eventId,
  finalizeEvent,
  parseEventLine,
  serializeEvent,
  validateEvent,
  SCHEMA_VERSION,
} from "./schema.js";
export type {
  Actor,
  EventDraft,
  EventLink,
  EvidenceEvent,
  Producer,
  ProducerAgentContext,
  RepoContext,
  StreamRef,
} from "./schema.js";
export { canonicalJson, sha256Hex } from "./canonical.js";
export {
  currentBranch,
  findRepo,
  git,
  GitError,
  gitUserIdentity,
  headSha,
  repoIdentity,
} from "./git.js";
export type { GitUserIdentity, RepoInfo } from "./git.js";
export { captureRules, collectEnvValues, loadConfig } from "./redact/config.js";
export type { AnnalsConfig } from "./redact/config.js";
export { addKnownSecrets, loadKnownSecrets } from "./redact/known-secrets.js";
export { RULES, RULESET_VERSION, rulesForTier, shannonEntropy } from "./redact/rules.js";
export type { RedactionRule, RuleTier } from "./redact/rules.js";
export {
  collectMatches,
  isExemptFromRedaction,
  redactDraft,
  redactText,
  walkStrings,
} from "./redact/apply.js";
export type { ExtraValueGroup, RedactionRecord } from "./redact/apply.js";
export {
  addToAllowlist,
  collectStrings,
  filterFindings,
  findingGuidance,
  FIXTURE_MARKER_RE,
  formatFinding,
  formatGroupedReport,
  groupFindings,
  inAgentSession,
  loadAllowlist,
  renderFinding,
  scanEvents,
} from "./redact/scan.js";
export type { Finding, FingerprintGroup, RenderOptions } from "./redact/scan.js";
export { runReview, escapeLiteral, wrapRuns, renderView } from "./review.js";
export type { ReviewOptions, ReviewSummary, Run, Screen, ViewState } from "./review.js";
export {
  commitDateIso,
  defaultRewriteTarget,
  detectRewrites,
  parseReAnchor,
  patchIdOf,
  reAnchorDraft,
} from "./reanchor.js";
export type {
  DetectedRewrite,
  DetectRewritesResult,
  ReAnchorDraftOptions,
  ReAnchorMapping,
  UnmatchedBranch,
} from "./reanchor.js";
export { suggestMappings } from "./reanchor-suggest.js";
export type { BranchSuggestions, Suggestion } from "./reanchor-suggest.js";
export { forgeForRepo } from "./forge/forge.js";
export type { ForgeDriver, ForgePullRequest } from "./forge/forge.js";
