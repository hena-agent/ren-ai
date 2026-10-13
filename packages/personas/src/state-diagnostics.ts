import { Schema, SchemaIssue } from "effect";
import { isMap, isScalar, parseDocument } from "yaml";
import type { ParsedNode } from "yaml";
import { InitialState } from "./initial.ts";
import { parseCharacterDescription } from "./character-format.ts";

function issueAt(source: string, message: string, start: number, end: number) {
  return { message, start, end, line: source.slice(0, start).split("\n").length };
}

function location(
  source: string,
  root: ParsedNode | null,
  path: readonly PropertyKey[],
  offset: number,
  message: string,
) {
  let node: ParsedNode | null = root;
  let start = root?.range[0] ?? 0;
  let end = root?.range[1] ?? 0;
  for (const key of path) {
    if (!isMap(node)) break;
    const pair: (typeof node.items)[number] | undefined = node.items.find(
      (item) => isScalar(item.key) && String(item.key.value) === String(key),
    );
    if (!pair) {
      start = end;
      break;
    }
    start = pair.key.range[0];
    node = pair.value;
    end = node?.range[1] ?? pair.key.range[1];
  }
  return issueAt(source, message, offset + start, offset + end);
}

function fieldMessage(path: readonly PropertyKey[]) {
  const field = String(path.at(-1) ?? "State");
  if (
    ["mood", "energy", "stress", "connection", "solitude", "affection", "strength"].includes(field)
  )
    return `${field}: 정수 0–100이 필요합니다.`;
  if (field === "active") return "active: true 또는 false만 사용할 수 있습니다.";
  if (field === "persistence") return "persistence: lasting이어야 합니다.";
  if (field === "traits") return "traits: 특성 이름을 key로 가진 객체가 필요합니다.";
  if (path.length === 0)
    return "State는 컨디션 5개·초기 호감도 affection·traits를 포함한 YAML 객체여야 합니다.";
  return `${path.map(String).join(".")}: 필수 항목 또는 허용된 필드인지 확인해 주세요.`;
}

function stateIssues(source: string, personaSource?: string) {
  if (source.length > 16000)
    return [issueAt(source, "State는 16,000자 이하여야 합니다.", 16000, source.length)];
  const match = /^(\s*---\r?\n)([\s\S]*?)\r?\n---\s*$/.exec(source);
  if (!match)
    return [
      issueAt(
        source,
        "---로 감싼 YAML frontmatter만 작성해 주세요.",
        0,
        source.indexOf("\n") < 0 ? source.length : source.indexOf("\n"),
      ),
    ];
  const offset = match[1]!.length;
  const document = parseDocument(match[2]!, { logLevel: "silent" });
  if (document.errors.length)
    return document.errors.map((error) =>
      issueAt(
        source,
        `YAML 문법을 확인해 주세요. (${error.code})`,
        offset + error.pos[0],
        offset + error.pos[1],
      ),
    );
  let state: typeof InitialState.Type;
  try {
    state = Schema.decodeUnknownSync(InitialState)(document.toJS(), {
      errors: "all",
      onExcessProperty: "error",
    });
  } catch (cause) {
    if (!(cause instanceof Schema.SchemaError))
      return [location(source, document.contents, [], offset, "YAML 값과 참조를 확인해 주세요.")];
    return SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue).issues.map((issue) => {
      // Effect's formatter always supplies accumulated paths, including [] at the root.
      const path = issue.path!.map(String);
      return location(source, document.contents, path, offset, fieldMessage(path));
    });
  }
  if (personaSource === undefined) return [];
  let hidden: ReturnType<typeof parseCharacterDescription>["hidden"];
  try {
    hidden = parseCharacterDescription(personaSource).hidden;
  } catch {
    return [
      location(
        source,
        document.contents,
        ["traits"],
        offset,
        "특성을 비교하려면 Persona 형식을 먼저 정리해 주세요.",
      ),
    ];
  }
  const issues: ReturnType<typeof issueAt>[] = [];
  for (const trait of hidden) {
    if (state.traits[trait.name]?.strength !== trait.strength)
      issues.push(
        location(
          source,
          document.contents,
          ["traits", trait.name, "strength"],
          offset,
          `${trait.name}: Persona의 강도 ${trait.strength}과 일치해야 합니다.`,
        ),
      );
  }
  for (const name of Object.keys(state.traits)) {
    if (!hidden.some((trait) => trait.name === name))
      issues.push(
        location(
          source,
          document.contents,
          ["traits", name],
          offset,
          `${name}: Persona에 없는 특성입니다.`,
        ),
      );
  }
  return issues;
}

export function stateStatus(source: string, personaSource?: string) {
  if (!source.trim()) return { state: "empty" as const, label: "초기값 없음", issues: [] };
  const issues = stateIssues(source, personaSource);
  return {
    state: issues.length ? ("invalid" as const) : ("valid" as const),
    label: issues.length ? `오류 ${issues.length}개` : "형식 정상",
    issues,
  };
}
