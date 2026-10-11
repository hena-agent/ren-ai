import { Schema } from "effect";
import { parseDocument, stringify } from "yaml";
import { PersonaError } from "./model.ts";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

const Score = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 100 }));
export const InitialScores = Schema.Struct({
  mood: Score,
  energy: Score,
  stress: Score,
  connection: Score,
  solitude: Score,
});
export const InitialState = Schema.Struct({
  ...InitialScores.fields,
  traits: Schema.Record(
    Schema.String.check(Schema.isPattern(/\S/)),
    Schema.Struct({
      strength: Score,
      active: Schema.Boolean,
      persistence: Schema.Literal("lasting"),
    }),
  ),
});
export const InitialDocuments = Schema.Struct({
  state: Schema.String.check(Schema.isMaxLength(16000)),
  memory: Schema.String.check(Schema.isMaxLength(16000)),
});
export type InitialDocuments = typeof InitialDocuments.Type;

export function parseInitialState(source: string) {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\s*$/.exec(source.trim());
    if (!match) throw new Error("Expected STATE frontmatter only");
    const document = parseDocument(match[1]!, { logLevel: "silent" });
    if (document.errors.length) throw new Error("Invalid STATE YAML");
    return Schema.decodeUnknownSync(InitialState)(document.toJS(), { onExcessProperty: "error" });
  } catch {
    throw new PersonaError(
      "invalid",
      "STATE.md는 현재 상태 5개(정수 0–100)와 traits만 포함한 YAML frontmatter여야 합니다.",
    );
  }
}

export const serializeInitialState = (state: typeof InitialState.Type) =>
  `---\n${stringify(state)}---\n`;

export function validateInitialDocuments(documents: InitialDocuments) {
  parseInitialState(documents.state);
  if (documents.state.length > 16000 || documents.memory.length > 16000)
    throw new PersonaError("invalid", "초기값 문서는 각각 16,000자 이하여야 합니다.");
  if (!/^# 현재 생활(?:\r?\n|$)/.test(documents.memory.trim()))
    throw new PersonaError("invalid", "MEMORY.md는 ‘# 현재 생활’ 제목으로 시작해야 합니다.");
  return documents;
}

export function validateInitialMemory(memory: string) {
  if (memory.length > 16000)
    throw new PersonaError("invalid", "Memory는 16,000자 이하여야 합니다.");
  const nodes = fromMarkdown(memory).children;
  const title = nodes[0];
  if (
    title?.type !== "heading" ||
    title.depth !== 1 ||
    toString(title) !== "현재 생활" ||
    !nodes
      .slice(1)
      .some(
        (node) =>
          (node.type === "paragraph" || node.type === "list") &&
          toString(node, { includeHtml: false }).trim(),
      )
  )
    throw new PersonaError(
      "invalid",
      "Memory에 ‘# 현재 생활’ 제목과 실제 생활 내용을 작성해 주세요.",
    );
  return memory;
}
