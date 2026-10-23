import ts from "typescript";
import { assertInputActive, inputLimits, InputBudgetError } from "../input-budget.js";
import type { Diagnostic } from "../types.js";
import { uniqueSorted } from "./types.js";

export const JS_PARSER_IDENTITY = Object.freeze({ engine: "typescript" as const, version: ts.version });

export interface JsDependencyAnalysis {
  specifiers: string[];
  diagnostics: Diagnostic[];
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  return /\.(?:[cm]?ts)$/i.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

/** Parse dependencies and uncertainty together, without interpreting strings as code. */
export function parseJsDependencies(source: string, file = "module.ts"): JsDependencyAnalysis {
  assertInputActive();
  if (Buffer.byteLength(source) > inputLimits().maxFileBytes) throw new InputBudgetError("JavaScript parsing exceeds maxFileBytes budget");
  const diagnostics: Diagnostic[] = [];
  const specifiers: string[] = [];
  const parseError = (): void => {
    diagnostics.push({ code: "mapping-parse-error", severity: "warning", files: [file],
      message: `Cannot reliably parse JavaScript/TypeScript dependencies in ${file}; selecting all known tests is a conservative fallback` });
  };
  let tree: ts.SourceFile;
  try {
    tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, scriptKind(file));
  } catch (error) {
    if (error instanceof InputBudgetError) throw error;
    parseError();
    return { specifiers, diagnostics };
  }
  assertInputActive();
  // The pinned compiler exposes parser diagnostics on its source file. Fail
  // conservatively if a future compiler removes that runtime contract.
  const errors: unknown = Reflect.get(tree, "parseDiagnostics");
  if (!Array.isArray(errors) || errors.length > 0) parseError();
  const addLiteral = (node: ts.Node | undefined): boolean => {
    if (!node || !ts.isStringLiteralLike(node)) return false;
    specifiers.push(node.text);
    if (specifiers.length > inputLimits().maxGraphEdges) throw new InputBudgetError("Import expressions exceed maxGraphEdges budget");
    return true;
  };
  const pending: ts.Node[] = [tree];
  while (pending.length) {
    assertInputActive();
    const node = pending.pop()!;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) addLiteral(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) addLiteral(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) addLiteral(node.argument.literal);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
      if (!addLiteral(node.arguments[0])) {
        diagnostics.push({ code: "mapping-dynamic-dependency", severity: "warning", files: [file],
          message: `Dependency call in ${file} uses an expression that the static import graph cannot resolve; selecting all known tests is a conservative fallback` });
      }
    }
    ts.forEachChild(node, (child) => { pending.push(child); });
  }
  return { specifiers: uniqueSorted(specifiers), diagnostics };
}
