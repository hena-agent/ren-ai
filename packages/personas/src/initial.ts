import { Schema } from "effect";
import { parseDocument, stringify } from "yaml";
import { PersonaError } from "./model.ts";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import type { InitialDocuments } from "./initial-documents.ts";
import { LanguageProficiency } from "./languages.ts";
export { InitialDocuments } from "./initial-documents.ts";

const Score = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 100 }));
export const InitialScores = Schema.Struct({
  mood: Score,
  energy: Score,
  stress: Score,
  connection: Score,
  solitude: Score,
  affection: Score,
});
export const InitialState = Schema.Struct({
  ...InitialScores.fields,
  languageProficiency: Schema.optionalKey(LanguageProficiency),
  traits: Schema.Record(
    Schema.String.check(Schema.isPattern(/\S/)),
    Schema.Struct({
      strength: Score,
      active: Schema.Boolean,
      persistence: Schema.Literal("lasting"),
    }),
  ),
});

export const ConversationState = Schema.Struct({
  ...InitialState.fields,
  affection: Schema.optionalKey(InitialScores.fields.affection),
});

function parseState<T>(source: string, schema: Schema.Codec<T>) {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\s*$/.exec(source.trim());
    if (!match) throw new Error("Expected STATE frontmatter only");
    const document = parseDocument(match[1]!, { logLevel: "silent" });
    if (document.errors.length) throw new Error("Invalid STATE YAML");
    return Schema.decodeUnknownSync(schema)(document.toJS(), { onExcessProperty: "error" });
  } catch {
    throw new PersonaError(
      "invalid",
      "STATE.md의 컨디션·호감도는 정수 0–100이어야 하며 traits와 함께 YAML frontmatter로 작성해야 합니다.",
    );
  }
}

export const parseInitialState = (source: string) => parseState(source, InitialState);
export const parseConversationState = (source: string) => parseState(source, ConversationState);

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
