import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

export interface InputLimits {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  maxJsonBytes?: number;
  maxJsonDepth?: number;
  maxJsonNodes?: number;
  maxGraphEdges?: number;
}
export const DEFAULT_INPUT_LIMITS: Required<InputLimits> = {
  maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxFiles: 50_000,
  maxJsonBytes: 8 * 1024 * 1024, maxJsonDepth: 64, maxJsonNodes: 200_000, maxGraphEdges: 500_000,
};
export class InputBudgetError extends Error { override name = "InputBudgetError"; }
interface Budget { limits: Required<InputLimits>; files: Map<string, number>; bytes: number; deadline?: number; signal?: AbortSignal }
const budgets = new AsyncLocalStorage<Budget>();

export function resolveInputLimits(options: InputLimits = {}): Required<InputLimits> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new InputBudgetError("Input limits must be an object");
  const limits = { ...DEFAULT_INPUT_LIMITS, ...options };
  for (const [name, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_INPUT_LIMITS, name) || !Number.isSafeInteger(value) || value < 1) throw new InputBudgetError(`Input budget ${name} must be a positive safe integer`);
  }
  return limits;
}
export function withInputBudget<T>(options: { limits?: InputLimits; deadline?: number; signal?: AbortSignal }, action: () => T): T {
  return budgets.run({ limits: resolveInputLimits(options.limits), files: new Map(), bytes: 0, deadline: options.deadline, signal: options.signal }, action);
}
export function assertInputActive(): void {
  const budget = budgets.getStore();
  if (budget?.signal?.aborted || budget?.deadline !== undefined && Date.now() >= budget.deadline) throw new InputBudgetError("Input processing exceeded the verification deadline or was cancelled");
}
export function inputLimits(): Required<InputLimits> { return budgets.getStore()?.limits ?? DEFAULT_INPUT_LIMITS; }
export function accountInput(file: string, bytes: number): void {
  assertInputActive();
  const budget = budgets.getStore(), limits = inputLimits();
  if (bytes > limits.maxFileBytes) throw new InputBudgetError(`Input file exceeds maxFileBytes budget (${limits.maxFileBytes}): ${file}`);
  if (!budget) return;
  const identity = path.resolve(file);
  const old = budget.files.get(identity) ?? 0;
  if (!budget.files.has(identity) && budget.files.size >= limits.maxFiles) throw new InputBudgetError(`Input file count exceeds maxFiles budget (${limits.maxFiles})`);
  const total = budget.bytes + Math.max(0, bytes - old);
  if (total > limits.maxTotalBytes) throw new InputBudgetError(`Input bytes exceed maxTotalBytes budget (${limits.maxTotalBytes})`);
  budget.bytes = total; budget.files.set(identity, Math.max(old, bytes));
}

/** Read the same bounded file descriptor that was checked, including growth detection. */
export function readBoundedFile(file: string, maxBytes = inputLimits().maxFileBytes): Buffer {
  assertInputActive();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new InputBudgetError(`Input is not a regular file: ${file}`);
    if (stat.size > maxBytes) throw new InputBudgetError(`Input exceeds size budget (${maxBytes} bytes): ${file}`);
    accountInput(file, stat.size);
    const result = Buffer.alloc(stat.size + 1);
    let size = 0, read = 0;
    do { assertInputActive(); read = readSync(fd, result, size, Math.min(64 * 1024, result.length - size), null); size += read; } while (read > 0 && size < result.length);
    const after = fstatSync(fd);
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new InputBudgetError(`Input changed during bounded read: ${file}`);
    return result.subarray(0, size);
  } finally { closeSync(fd); }
}

export function parseBoundedJson(text: string, source = "JSON input"): unknown {
  const limits = inputLimits();
  if (Buffer.byteLength(text) > limits.maxJsonBytes) throw new InputBudgetError(`${source}: JSON exceeds maxJsonBytes budget (${limits.maxJsonBytes})`);
  let depth = 0, nodes = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    if ((i & 4095) === 0) assertInputActive();
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "[" || char === "{") { depth++; nodes++; }
    else if (char === "]" || char === "}") depth--;
    else if (char === "," || char === ":") nodes++;
    if (depth > limits.maxJsonDepth) throw new InputBudgetError(`${source}: JSON exceeds maxJsonDepth budget (${limits.maxJsonDepth})`);
    if (nodes > limits.maxJsonNodes) throw new InputBudgetError(`${source}: JSON exceeds maxJsonNodes budget (${limits.maxJsonNodes})`);
  }
  assertInputActive();
  const value: unknown = JSON.parse(text);
  assertInputActive();
  return value;
}
export function readJsonInput(file: string): unknown {
  return parseBoundedJson(readBoundedFile(file, Math.min(inputLimits().maxFileBytes, inputLimits().maxJsonBytes)).toString("utf8"), file);
}

/** Stop serialization before accumulating an artifact too large for its reader. */
export function stringifyBoundedJson(value: unknown, maxBytes = inputLimits().maxJsonBytes, format: "pretty" | "compact" = "pretty"): string {
  if (format === "compact") return stringifyCompactBoundedJson(value, maxBytes);
  let bytes = 0, nodes = 0, root = true;
  const limits = inputLimits();
  const depth = new WeakMap<object, number>(), started = new WeakSet<object>();
  const json = JSON.stringify(value, function (key, item: unknown) {
    assertInputActive();
    if (item === undefined || typeof item === "function" || typeof item === "symbol") {
      if (!Array.isArray(this)) return item;
      item = null;
    }
    const parentDepth = depth.get(this as object) ?? -1;
    if (!root) {
      if (!started.has(this as object)) { started.add(this as object); bytes += 1 + parentDepth * 2; }
      else { bytes++; nodes++; }
      bytes += 1 + (parentDepth + 1) * 2;
      if (!Array.isArray(this)) { bytes += Buffer.byteLength(JSON.stringify(key)) + 2; nodes++; }
    }
    if (item !== null && typeof item === "object") {
      bytes += 2; nodes++; depth.set(item, parentDepth + 1); started.delete(item);
      if (parentDepth + 2 > limits.maxJsonDepth) throw new InputBudgetError(`Artifact JSON exceeds maxJsonDepth budget (${limits.maxJsonDepth})`);
    }
    else bytes += Buffer.byteLength(JSON.stringify(item));
    root = false;
    if (nodes > limits.maxJsonNodes) throw new InputBudgetError(`Artifact JSON exceeds maxJsonNodes budget (${limits.maxJsonNodes})`);
    if (bytes + 1 > maxBytes) throw new InputBudgetError(`Artifact JSON exceeds maxJsonBytes budget (${maxBytes})`);
    return item;
  }, 2);
  if (json === undefined || Buffer.byteLength(json) + 1 > maxBytes) throw new InputBudgetError(`Artifact JSON exceeds maxJsonBytes budget (${maxBytes})`);
  return `${json}\n`;
}

/** Private machine transport: count the compact wire syntax before it is emitted. */
function stringifyCompactBoundedJson(value: unknown, maxBytes: number): string {
  const limits = inputLimits();
  let bytes = 0, nodes = 0, root = true;
  const stack: Array<{ value: object; depth: number; members: number }> = [];
  const check = () => {
    if (nodes > limits.maxJsonNodes) throw new InputBudgetError(`Artifact JSON exceeds maxJsonNodes budget (${limits.maxJsonNodes})`);
    if (bytes + 1 > maxBytes) throw new InputBudgetError(`Artifact JSON exceeds maxJsonBytes budget (${maxBytes})`);
  };
  const stringBytes = (text: string) => {
    bytes += 2;
    for (let index = 0; index < text.length; index++) {
      if ((index & 4095) === 0) assertInputActive();
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92) bytes += 2;
      else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
      else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
      else bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
      check();
    }
  };
  const json = JSON.stringify(value, function (key, item: unknown) {
    assertInputActive();
    if (item === undefined || typeof item === "function" || typeof item === "symbol") {
      if (!Array.isArray(this)) return item;
      item = null;
    }
    if (!root) while (stack.length && stack[stack.length - 1]!.value !== this) stack.pop();
    const parent = root ? undefined : stack[stack.length - 1];
    if (parent) {
      if (parent.members++) { bytes++; nodes++; }
      if (!Array.isArray(this)) { stringBytes(key); bytes++; nodes++; }
    }
    if (item !== null && typeof item === "object") {
      // JSON.stringify unboxes these after the replacer; rejecting them keeps
      // oversized boxed strings from bypassing the pre-allocation byte guard.
      if (["[object String]", "[object Number]", "[object Boolean]", "[object BigInt]"].includes(Object.prototype.toString.call(item))) throw new InputBudgetError("Artifact JSON contains a boxed primitive");
      if (stack.some(frame => frame.value === item)) throw new InputBudgetError("Artifact JSON contains a cycle");
      const depth = (parent?.depth ?? 0) + 1;
      if (depth > limits.maxJsonDepth) throw new InputBudgetError(`Artifact JSON exceeds maxJsonDepth budget (${limits.maxJsonDepth})`);
      bytes += 2; nodes++;
      stack.push({ value: item, depth, members: 0 });
    } else if (typeof item === "string") stringBytes(item);
    else bytes += Buffer.byteLength(JSON.stringify(item));
    root = false;
    check();
    return item;
  });
  if (json === undefined || Buffer.byteLength(json) + 1 > maxBytes) throw new InputBudgetError(`Artifact JSON exceeds maxJsonBytes budget (${maxBytes})`);
  return `${json}\n`;
}
