export { SCHEMA_VERSION, TOOL_VERSION } from "./types.js";
export type {
  AcceptGapRule,
  ChangedFile,
  CheckId,
  CheckResult,
  Evidence,
  FailOnLevel,
  Finding,
  Gap,
  Language,
  MappedTest,
  MappingStrategy,
  PatchproveGates,
  ResolvedConfig,
  RiskLevel,
  RunOptions,
  SummaryRisk,
} from "./types.js";
export {
  classifyPath,
  isLockfilePath,
  meetsFailOn,
  maxRisk,
  riskForPathKind,
  riskRank,
} from "./risk.js";
export {
  collectLanguages,
  isMappableSource,
  isSourceFile,
  isTestFile,
  languageOf,
  mapTestsForFile,
  testBasenameKey,
  testCandidatesFor,
} from "./mapping.js";
export { scanSecrets, shannonEntropyForTest } from "./secrets.js";
export {
  buildEvidence,
  buildImpact,
  collectGaps,
  failedCheckFindings,
  filterIgnored,
  pathFindings,
  toChangedFile,
} from "./evidence.js";
export { formatHumanReport, formatMarkdownReport, formatShortSummary } from "./report.js";
export { analyze, executeRun, render, writeEvidence } from "./run.js";
export {
  listGaps,
  provePatch,
  readEvidenceFile,
  runOptionsFromInput,
  LIST_GAPS_DESCRIPTION,
  PROVE_PATCH_DESCRIPTION,
} from "./mcp-tools.js";
export type { ListGapsInput, ListGapsResult, ProvePatchInput, ProvePatchResult } from "./mcp-tools.js";
export { MCP_TOOL_NAMES, createMcpServer, startMcpServer } from "./mcp.js";
export { buildHookResponse, executeHook, hookFailurePayload, isHookAdapter, isHookEvent } from "./hook.js";
export type { HookAdapter, HookEvent, HookOptions, HookResponse } from "./hook.js";
export {
  DEFAULT_CLI,
  executeInitAgent,
  isPatchproveHookCommand,
  mergeClaudeSettings,
  mergeMcpConfig,
} from "./init-agent.js";
export type { InitAgentOptions, InitAgentResult } from "./init-agent.js";
export { findPackageRoot, skillTemplatePath } from "./pkg.js";
export { detectTools } from "./detect.js";
export {
  acceptRuleFromToken,
  findConfigPath,
  loadConfigFile,
  mergeConfig,
  parseConfigObject,
  parseConfigText,
  resolveConfig,
} from "./config.js";
export { applyAcceptedGaps, findAcceptMatch, isOpenGap, matchAcceptRule } from "./accept.js";
export { globToRegExp, matchAnyGlob, matchGlob } from "./glob.js";
export { loadCoverageMap, mapTestsForSource, parseCoverageText } from "./coverage.js";
export { toSarif, writeSarif } from "./sarif.js";
