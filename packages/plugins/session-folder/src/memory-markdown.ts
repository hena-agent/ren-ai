import { Schema } from "effect";
import { parseDocument, stringify } from "yaml";
import {
  memoryRecord,
  runtimeSnapshot,
  runtimeState,
  type RuntimeSnapshot,
} from "./memory-model.ts";

const metadata = {
  additional: Schema.optionalKey(runtimeSnapshot.fields.additional),
  lastChange: runtimeSnapshot.fields.stateChange,
  fieldChanges: runtimeSnapshot.fields.fieldChanges,
};
const stateDocument = Schema.Struct({ ...runtimeState.fields, ...metadata });
const recordMetadata = Schema.Struct({
  ...memoryRecord.fields,
  text: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
});

function frontmatter(source: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Expected Markdown frontmatter");
  const document = parseDocument(match[1]!, { logLevel: "silent" });
  if (document.errors.length) throw new Error("Invalid memory YAML");
  return { document, body: match[2]!.replace(/^\r?\n/, "") };
}

export function readState(source: string) {
  try {
    const { document, body } = frontmatter(source);
    if (body.trim()) throw new Error("Expected STATE frontmatter only");
    const {
      additional = {},
      lastChange,
      fieldChanges,
      ...scores
    } = Schema.decodeUnknownSync(stateDocument)(document.toJS(), { onExcessProperty: "error" });
    return {
      ...(Object.keys(scores).length && {
        state: Schema.decodeUnknownSync(runtimeState)(scores),
      }),
      additional,
      ...(lastChange && { stateChange: lastChange }),
      ...(fieldChanges && { fieldChanges }),
    };
  } catch (cause) {
    throw new Error("Invalid Conversation STATE.md", { cause });
  }
}

export function readShortTerm(source: string) {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n"))
    return { shortTerm: Schema.decodeUnknownSync(runtimeSnapshot.fields.shortTerm)(source) };
  const { document, body } = frontmatter(source);
  const { changes } = Schema.decodeUnknownSync(
    Schema.Struct({
      changes: runtimeSnapshot.fields.shortTermChanges,
    }),
  )(document.toJS(), { onExcessProperty: "error" });
  return {
    shortTerm: Schema.decodeUnknownSync(runtimeSnapshot.fields.shortTerm)(body),
    ...(changes && { shortTermChanges: changes }),
  };
}

export function readLongTerm(source: string, id: string) {
  try {
    const { document, body } = frontmatter(source);
    const fields = Schema.decodeUnknownSync(recordMetadata)(document.toJS(), {
      onExcessProperty: "error",
    });
    if (fields.id !== id) throw new Error("Memory id does not match its file");
    return {
      ...fields,
      text: fields.clarity === "clear" ? body : "",
      summary:
        fields.clarity === "faded"
          ? body
          : fields.clarity === "clear"
            ? (fields.summary ?? "")
            : "",
    };
  } catch (cause) {
    throw new Error("Invalid Conversation long-term Markdown", { cause });
  }
}

export function writeLongTerm(record: RuntimeSnapshot["longTerm"][number]) {
  const { text, summary, ...fields } = record;
  const body = record.clarity === "clear" ? text : record.clarity === "faded" ? summary : "";
  return `---\n${stringify({ ...fields, ...(record.clarity === "clear" && { summary }) })}---\n\n${body}`;
}
