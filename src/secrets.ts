import type { DiffFile } from "./git.js";
import { isLockfilePath } from "./risk.js";
import type { Finding } from "./types.js";

interface SecretPattern {
  id: string;
  label: string;
  regex: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { id: "aws-access-key", label: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "github-pat", label: "GitHub personal access token", regex: /\bghp_[A-Za-z0-9]{36}\b/g },
  {
    id: "github-fine-grained",
    label: "GitHub fine-grained token",
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  { id: "slack-token", label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "google-api", label: "Google API key", regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { id: "openai", label: "OpenAI-style key", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { id: "anthropic", label: "Anthropic-style key", regex: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g },
  {
    id: "private-key",
    label: "Private key header",
    regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
  },
  {
    id: "generic-secret-assign",
    label: "Assigned high-entropy secret",
    regex:
      /(?:api[_-]?key|secret|token|passwd|password|credential)\s*[:=]\s*['"]([A-Za-z0-9/+_=.-]{20,})['"]/gi,
  },
];

const ENTROPY_TOKEN = /['"`]([A-Za-z0-9/+_\-=]{24,})['"`]/g;

function shannonEntropy(value: string): number {
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksLikePlaceholder(value: string): boolean {
  return /(example|changeme|placeholder|dummy|fake|xxx|your[_-]?key|todo)/i.test(value);
}

function skipSecretFile(filePath: string): boolean {
  if (isLockfilePath(filePath)) return true;
  return /(^|\/)(node_modules|dist|coverage|vendor)\//.test(filePath);
}

function looksLikeKnownHash(value: string, line: string): boolean {
  if (/^sha[0-9]+-/i.test(value)) return true;
  if (/"integrity"\s*:/.test(line)) return true;
  if (/\bsha(1|256|512)-/.test(line)) return true;
  if (/^[a-f0-9]{40,64}$/i.test(value)) return true;
  return false;
}

function addedLines(patch: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      newLine = match ? Number(match[1]) : 0;
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) {
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      continue;
    } else {
      newLine += 1;
    }
  }
  return out;
}

export function scanSecrets(files: DiffFile[]): Finding[] {
  const findings: Finding[] = [];
  let counter = 0;

  for (const file of files) {
    if (file.status === "deleted") continue;
    if (skipSecretFile(file.path)) continue;
    const lines = file.patch ? addedLines(file.patch) : [];
    if (lines.length === 0) continue;

    for (const { line, text } of lines) {
      for (const pattern of PATTERNS) {
        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(text))) {
          const value = match[1] ?? match[0];
          if (
            pattern.id === "generic-secret-assign" &&
            looksLikePlaceholder(value)
          ) {
            continue;
          }
          counter += 1;
          findings.push({
            id: `secret-${counter}`,
            kind: "secret",
            risk: "critical",
            message: `${pattern.label} in ${file.path}:${line}`,
            path: file.path,
            line,
          });
        }
      }

      ENTROPY_TOKEN.lastIndex = 0;
      let tokenMatch: RegExpExecArray | null;
      while ((tokenMatch = ENTROPY_TOKEN.exec(text))) {
        const token = tokenMatch[1] ?? "";
        if (token.length < 24 || looksLikePlaceholder(token)) continue;
        if (looksLikeKnownHash(token, text)) continue;
        if (shannonEntropy(token) < 4.5) continue;
        if (findings.some((f) => f.path === file.path && f.line === line && f.kind === "secret")) {
          continue;
        }
        counter += 1;
        findings.push({
          id: `secret-${counter}`,
          kind: "secret",
          risk: "critical",
          message: `High-entropy token in ${file.path}:${line}`,
          path: file.path,
          line,
        });
      }
    }
  }

  return findings;
}

export function shannonEntropyForTest(value: string): number {
  return shannonEntropy(value);
}
