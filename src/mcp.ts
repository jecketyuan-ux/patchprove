#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  LIST_GAPS_DESCRIPTION,
  listGaps,
  listGapsToMcpContent,
  PROVE_PATCH_DESCRIPTION,
  provePatch,
  provePatchToMcpContent,
} from "./mcp-tools.js";
import { TOOL_VERSION } from "./types.js";
import { canonicalPath } from "./paths.js";

const failOnSchema = z.enum(["high", "critical", "none"]).optional();
const acceptSchema = z.array(z.string()).optional();

const provePatchShape = {
  cwd: z.string().optional().describe("Repository to analyze (default: process cwd)"),
  base: z.string().optional().describe("Diff base ref (use with head for a PR range)"),
  head: z.string().optional().describe("Diff head ref (default HEAD when base is set)"),
  failOn: failOnSchema.describe("Exit-threshold equivalent: high | critical | none"),
  accept: acceptSchema.describe("Gap ids or path patterns to accept (added to config acceptGaps)"),
  config: z.string().optional().describe("Explicit .patchprove.yml / .yaml path"),
  out: z.string().optional().describe("If set, write evidence.json to this path"),
  spec: z.string().optional(),
  baseline: z.string().optional(),
  failOnNewGaps: failOnSchema,
  protocol: z.union([z.literal(1), z.literal(2)]).optional(),
  strict: z.boolean().optional(),
  isolate: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  allowPlugins: z.boolean().optional(),
  strictConfig: z.boolean().optional(),
  adapterInputs: z.array(z.object({ adapter: z.enum(["nx", "turbo", "testmon"]), path: z.string() })).optional(),
  sarif: z.string().optional(),
  receipt: z.union([z.boolean(), z.string()]).optional(),
  sign: z.boolean().optional(),
  ignore: z.array(z.string()).optional().describe("Path globs to exclude"),
  disableGate: z
    .array(z.enum(["typecheck", "lint", "tests", "secrets"]))
    .optional()
    .describe("Gates to disable"),
};

const listGapsShape = {
  ...provePatchShape,
  evidencePath: z
    .string()
    .optional()
    .describe("Read open gaps from this evidence JSON instead of running a fresh pipeline"),
};

export const MCP_TOOL_NAMES = ["prove_patch", "list_gaps"] as const;

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "patchprove",
    version: TOOL_VERSION,
  });

  server.registerTool(
    "prove_patch",
    {
      title: "Prove patch",
      description: PROVE_PATCH_DESCRIPTION,
      inputSchema: provePatchShape,
    },
    async (args) => {
      try {
        const result = await provePatch(args);
        return { content: [{ type: "text", text: provePatchToMcpContent(result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `patchprove prove_patch failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_gaps",
    {
      title: "List open gaps",
      description: LIST_GAPS_DESCRIPTION,
      inputSchema: listGapsShape,
    },
    async (args) => {
      try {
        const result = await listGaps(args);
        return { content: [{ type: "text", text: listGapsToMcpContent(result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `patchprove list_gaps failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(canonicalPath(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  startMcpServer().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`patchprove-mcp: ${message}\n`);
    process.exitCode = 1;
  });
}
