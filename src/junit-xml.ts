import { assertInputActive, inputLimits } from "./input-budget.js";

export interface JunitXmlElement {
  name: string;
  attributes: Record<string, string>;
  children: JunitXmlElement[];
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:quot|apos|lt|gt|amp);|&#(?:x[0-9a-f]+|[0-9]+);|&/gi, (entity) => {
    const fixed: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
    if (fixed[entity]) return fixed[entity]!;
    if (entity === "&") throw new Error("Unsupported XML entity");
    const code = entity.startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    if (!Number.isInteger(code) || !(code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) {
      throw new Error("Invalid XML character reference");
    }
    return String.fromCodePoint(code);
  });
}

function tag(text: string): { name: string; attributes: Record<string, string> } {
  const name = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(text)?.[0];
  if (!name) throw new Error("Invalid XML element name");
  const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
  const pattern = /[ \t\r\n]+([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"<]*)"|'([^'<]*)')/gy;
  let offset = name.length, count = 0;
  while (offset < text.length) {
    if (/^[ \t\r\n]*$/.test(text.slice(offset))) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match || Object.hasOwn(attributes, match[1]!)) throw new Error("Malformed or duplicate XML attribute");
    if (++count > 128) throw new Error("JUnit XML attribute budget exceeded");
    attributes[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
    offset = pattern.lastIndex;
  }
  return { name, attributes };
}

/** Bounded UTF-8 XML subset: text, comments and CDATA never become elements. No DTDs, entities or external resources. */
export function parseJunitXml(raw: Buffer): JunitXmlElement {
  assertInputActive();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) throw new Error("Invalid XML character");
  const stack: JunitXmlElement[] = [];
  let root: JunitXmlElement | undefined, offset = 0, nodes = 0, declared = false;
  while (offset < text.length) {
    assertInputActive();
    const opening = text.indexOf("<", offset);
    const content = text.slice(offset, opening < 0 ? text.length : opening);
    if ((!stack.length && content.trim()) || content.includes("]]>") ) throw new Error("Unexpected XML text");
    decodeEntities(content);
    if (opening < 0) { offset = text.length; break; }
    if (text.startsWith("<!--", opening)) {
      const end = text.indexOf("-->", opening + 4);
      if (end < 0 || text.slice(opening + 4, end).includes("--")) throw new Error("Malformed XML comment");
      offset = end + 3; continue;
    }
    if (text.startsWith("<![CDATA[", opening)) {
      const end = text.indexOf("]]>", opening + 9);
      if (!stack.length || end < 0) throw new Error("Malformed XML CDATA");
      offset = end + 3; continue;
    }
    if (text.startsWith("<?", opening)) {
      const end = text.indexOf("?>", opening + 2);
      if (root || declared || opening !== 0 || end < 0) throw new Error("Unsupported XML processing instruction");
      const declaration = tag(text.slice(opening + 2, end));
      if (declaration.name !== "xml" || declaration.attributes.version !== "1.0" ||
        declaration.attributes.encoding !== undefined && !/^utf-8$/i.test(declaration.attributes.encoding)) throw new Error("Unsupported XML declaration");
      declared = true; offset = end + 2; continue;
    }
    if (text.startsWith("<!", opening)) throw new Error("Unsupported XML declaration or entity");
    let end = opening + 1, quote: string | undefined;
    for (; end < text.length; end++) {
      if ((end & 4095) === 0) assertInputActive();
      const character = text[end]!;
      if (quote) { if (character === quote) quote = undefined; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end === text.length) throw new Error("Truncated XML element");
    const body = text.slice(opening + 1, end);
    if (body.startsWith("/")) {
      const name = body.slice(1).trimEnd();
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) || stack.pop()?.name !== name) throw new Error("Mismatched XML closing element");
    } else {
      const selfClosing = body.endsWith("/");
      const entry: JunitXmlElement = { ...tag(selfClosing ? body.slice(0, -1) : body), children: [] };
      if (++nodes > Math.min(200_000, inputLimits().maxJsonNodes) || stack.length + 1 > Math.min(64, inputLimits().maxJsonDepth)) throw new Error("JUnit XML structure budget exceeded");
      if (stack.length) stack[stack.length - 1]!.children.push(entry);
      else { if (root) throw new Error("Multiple XML roots"); root = entry; }
      if (!selfClosing) stack.push(entry);
    }
    offset = end + 1;
  }
  if (!root || stack.length || !["testsuite", "testsuites"].includes(root.name)) throw new Error("Incomplete or unsupported JUnit document");
  return root;
}
