export { SCHEMA_VERSION, TOOL_VERSION } from "./types.js";
export type {
  AcceptGapRule,
  BaselineComparison,
  ChangedFile,
  CheckDigest,
  CheckId,
  CheckResult,
  ContractClauseResult,
  ContractResult,
  Evidence,
  EvidenceReceipt,
  EvidenceReceiptRef,
  FailOnLevel,
  FailOnOutcomeReason,
  Finding,
  Gap,
  Language,
  MappedTest,
  MappingStrategy,
  PatchproveContract,
  PatchproveGates,
  ReceiptOptionsSummary,
  ReceiptSignature,
  ResolvedConfig,
  RiskLevel,
  RunOptions,
  SummaryRisk,
} from "./types.js";
export { emptyContractResult, emptyDetectedTools, RECEIPT_SCHEMA_VERSION } from "./types.js";
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
export { analyze, executeRun, failOnOutcomeOf, render, resolveReceiptPath, shouldFailRun, writeEvidence } from "./run.js";
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
  mergeCursorHooks,
  mergeMcpConfig,
} from "./init-agent.js";
export type { InitAgentOptions, InitAgentResult } from "./init-agent.js";
export { findPackageRoot, skillTemplatePath, cursorRuleTemplatePath } from "./pkg.js";
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
export {
  attachReceiptRef,
  buildReceipt,
  canonicalEvidence,
  canonicalize,
  checkDigests,
  defaultReceiptPath,
  findPreviousReceiptHash,
  hashCanonical,
  hashEvidence,
  isReceiptShape,
  parseSigningKey,
  readReceiptFile,
  readReceiptHash,
  sortKeys,
  verifyReceipt,
  verifySignature,
  writeReceipt,
} from "./receipt.js";
export type { BuildReceiptInput, SigningMaterial, VerifyReceiptResult } from "./receipt.js";
export {
  builtinPlugins,
  pluginForPath,
  resolveLanguagePlugins,
  loadPluginModule,
  createPluginContext,
} from "./plugins/index.js";
export type { LanguagePlugin, PluginContext, PluginTestCommand } from "./plugins/index.js";
export { buildImportGraph, mapTestsFromGraph } from "./graph.js";
export {
  evaluateContract,
  extractYamlFromSpecMd,
  loadContract,
  parseContractObject,
  parseContractText,
} from "./spec.js";
export {
  compareToBaseline,
  DEFAULT_BASELINE_REL,
  findBaselinePath,
  writeBaseline,
} from "./baseline.js";
