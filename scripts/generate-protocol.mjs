import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const require = createRequire(import.meta.url);
const compilerVersion = require("json-schema-to-typescript/package.json").version;
const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.slice(2).includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  throw new Error("Usage: node scripts/generate-protocol.mjs [--check]");
}

function v2Requirements(schema) {
  const branch = schema.allOf?.find((entry) => entry.if?.properties?.schemaVersion?.pattern === "^2\\.");
  if (!branch || !Array.isArray(branch.then?.required) || branch.then.required.length === 0) {
    throw new Error("Protocol schema must declare the v2 required fields in allOf.then.required");
  }
  const required = [...new Set(branch.then.required)];
  for (const key of required) {
    if (typeof key !== "string" || !Object.hasOwn(schema.properties, key)) {
      throw new Error(`Unknown required protocol field: ${String(key)}`);
    }
  }
  return { required, refinements: branch.then.properties ?? {} };
}

function v2Aliases(schema, name) {
  const { required, refinements } = v2Requirements(schema);
  const requiredType = `${name.replace(/Wire$/, "")}V2RequiredFields`;
  const v2Type = `${name.replace(/Wire$/, "")}V2Wire`;
  const refinementsByField = { schemaVersion: { pattern: "^2\\." }, ...refinements };
  const fields = Object.entries(refinementsByField).map(([field, constraint]) => {
    const values = schema.properties[field]?.enum?.filter((value) => typeof value === "string" && value.startsWith("2."));
    const type = values?.length ? values.map((value) => JSON.stringify(value)).join(" | ") :
      constraint.pattern === "^2\\." ? "`2.${number}.${number}`" : undefined;
    if (!type) throw new Error(`Unsupported v2 refinement for ${field}; extend the generator explicitly`);
    return { field, type };
  });
  return [
    "/** Required fields derived from the protocol-2 conditional in the JSON schema. */",
    `export type ${requiredType} = ${required.map((key) => JSON.stringify(key)).join(" | ")};`,
    "",
    "/** Protocol-2 wire shape; conditional required fields are enforced without compiler if/then support. */",
    `export type ${v2Type} = Omit<${name}, ${fields.map(({ field }) => JSON.stringify(field)).join(" | ")}> &`,
    `  Required<Pick<${name}, ${requiredType}>> & {`,
    ...fields.map(({ field, type }) => `    ${field}: ${type};`),
    "  };",
    "",
  ].join("\n");
}

async function generatedModule(file, name) {
  const relative = `schema/${file}.schema.json`;
  const text = await readFile(path.join(root, relative), "utf8");
  const schema = JSON.parse(text);
  const schemaHash = createHash("sha256").update(text).digest("hex");
  const output = await compile({ ...schema, title: name }, name, {
    cwd: root,
    bannerComment: [
      "/* This file is generated. Do not edit directly.",
      ` * Source: ${relative}`,
      ` * Schema SHA-256: ${schemaHash}`,
      ` * Compiler: json-schema-to-typescript ${compilerVersion}`,
      " * Regenerate with: npm run generate:protocol",
      " */",
    ].join("\n"),
    additionalProperties: false,
    unknownAny: true,
    // Runtime schema validation enforces collection bounds. Keep the SDK's
    // longstanding array representation rather than introducing tuple APIs.
    ignoreMinAndMaxItems: true,
    style: { printWidth: 110, semi: true, singleQuote: false, tabWidth: 2, trailingComma: "none", endOfLine: "lf" },
  });
  return { destination: path.join(root, "src", "generated", `${file}.ts`), output: `${output}\n${v2Aliases(schema, name)}` };
}

const modules = await Promise.all([generatedModule("evidence", "EvidenceWire"), generatedModule("receipt", "ReceiptWire")]);
let drift = false;
for (const { destination, output } of modules) {
  if (check) {
    const current = await readFile(destination, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current !== output) {
      drift = true;
      process.stderr.write(`Generated protocol drift: ${path.relative(root, destination)}; run npm run generate:protocol\n`);
    }
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, output, "utf8");
  }
}
if (drift) process.exitCode = 1;
