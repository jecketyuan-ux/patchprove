export { SCHEMA_VERSION, COMPAT_SCHEMA_VERSION, TOOL_VERSION } from "./types.js";
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
  SnapshotIdentity,
  ExecutionLimits,
  ExecutionRecord,
  VerificationPlanItem,
  VerificationDecision,
  Diagnostic,
  EffectivePolicy,
  TestExecution,
  EnvironmentProvenance,
  PluginProvenance,
  JavaRuntimeProvenance,
  JavaTestRuntimeObservation,
  ReportArtifactReference,
} from "./types.js";
export { DEFAULT_INPUT_LIMITS, InputBudgetError, resolveInputLimits, withInputBudget } from "./input-budget.js";
export type { InputLimits } from "./input-budget.js";
export { verifyReportArchive } from "./report-archive.js";
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
export { analyze, analyzeAndWrite, produceArtifacts, executeRun, failOnOutcomeOf, render, resolveReceiptPath, shouldFailRun, writeEvidence } from "./run.js";
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
  hashReceiptPayload,
  publicKeyFingerprint,
  isReceiptShape,
  parseSigningKey,
  readReceiptFile,
  readReceiptHash,
  sortKeys,
  verifyReceipt,
  verifySignature,
  writeReceipt,
} from "./receipt.js";
export type { BuildReceiptInput, SigningMaterial, VerifyReceiptResult, ReceiptVerificationPolicy } from "./receipt.js";
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
  loadBaselineInput,
  loadBaselineEvidence,
  writeBaseline,
} from "./baseline.js";
export { evaluateVerification } from "./decision.js";
export { validateEvidence, validateReceipt } from "./validation.js";
export { findingFingerprint, gapFingerprint } from "./fingerprint.js";
export { captureSnapshotIdentity, createExecutionSnapshot } from "./snapshot.js";
export type { SnapshotOptions } from "./snapshot.js";
export { writeArtifactSet, verifyArtifactSet, writeJsonAtomic, writeTextAtomic } from "./artifacts.js";
export { loadAdapterEvidence, adapterInputHash, exportTurboEvidence, verifyCosignBundle } from "./adapters.js";
export type { AdapterKind, AdapterTaskEvidence, AdapterEvidence } from "./adapters.js";
export type { EvidenceWire, EvidenceV2Wire, EvidenceV2RequiredFields } from "./generated/evidence.js";
export type { ReceiptWire, ReceiptV2Wire, ReceiptV2RequiredFields } from "./generated/receipt.js";

export type { ProjectPolicy, ProjectGatePolicy } from "./types.js";
export type { PluginCapabilities } from "./plugins/types.js";
export type { ExecutionUnitBase, ToolUnit, TestUnit } from "./execution-units.js";
