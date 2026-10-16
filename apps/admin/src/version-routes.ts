import {
  PersonaError,
  parseCharacterDescription,
  serializePersona,
  versionedPersona,
} from "@ren-ai/personas";
import type { PersonaStore, PersonaRecord } from "@ren-ai/personas";
import { draftTokens, documentsOf, captureDocuments } from "./draft.ts";
import type { Draft } from "./draft.ts";
import { authorPersona } from "./authoring.ts";
import { assertSnapshot } from "./snapshot.ts";
import { protectEditingForm } from "./image-actions.ts";
import {
  operation,
  reportFailure,
  requestFields,
  requestId,
  validationFailure,
  protect,
  GenerationError,
} from "./logging.ts";
import type { LogFields } from "./logging.ts";
import { renderPage } from "./page.tsx";
import { html } from "./html-response.ts";
import type { InitialDocuments } from "@ren-ai/personas";

const normalized = (source: string) => source.replace(/\r\n?/g, "\n");
function dirty(draft: Draft) {
  const current = documentsOf(draft);
  const base = draft.initial?.base ?? { state: "", memory: "" };
  return (
    normalized(draft.preview) !== normalized(draft.base) ||
    normalized(current.state) !== normalized(base.state) ||
    normalized(current.memory) !== normalized(base.memory)
  );
}

const versionOperation = <T>(stage: string, fields: LogFields, run: () => Promise<T>) =>
  operation(stage, fields, async () => {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof PersonaError || cause instanceof GenerationError) throw cause;
      throw validationFailure(
        "Persona version operation failed",
        { code: "version_storage_failed" },
        cause,
      );
    }
  });

function versionNumber(value: string) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new PersonaError("invalid", "버전 번호를 확인해 주세요.");
  return Number(value);
}

function versionFailure(
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow caught version request and persistence failures before responding
  error: unknown,
  tokens: ReturnType<typeof draftTokens>,
  record?: PersonaRecord,
  draft?: Draft,
) {
  reportFailure(
    error,
    { stage: "persona.versions" },
    error instanceof PersonaError ? "warn" : "error",
  );
  return html(
    renderPage({
      ...(record && draft
        ? { record, editing: true, draft: tokens.encode(draft), documents: documentsOf(draft) }
        : { personas: [] }),
      error: `${error instanceof PersonaError ? error.message : "버전 작업을 완료하지 못했습니다."} (요청 ID: ${requestId()})`,
    }),
    error instanceof PersonaError
      ? { invalid: 400, conflict: 409, not_found: 404 }[error.kind]
      : 503,
  );
}

async function submittedVersion(
  request: Request,
  url: URL,
  store: PersonaStore,
  tokens: ReturnType<typeof draftTokens>,
  record: PersonaRecord,
  restore: boolean,
) {
  if (request.headers.get("origin") !== url.origin)
    throw new PersonaError("invalid", "잘못된 요청 출처입니다.");
  const form = await request.formData();
  protectEditingForm(form);
  let draft = tokens.decode(form.get("draft"));
  if (draft.id !== record.id) throw new PersonaError("invalid", "Persona ID가 일치하지 않습니다.");
  await assertSnapshot(store, draft);
  if (!restore) {
    record = authorPersona(form, record);
    draft = { ...captureDocuments(form, draft), preview: serializePersona(record) };
  }
  return { record, draft };
}

async function restoreVersion(
  store: PersonaStore,
  record: PersonaRecord,
  draft: Draft,
  initial: InitialDocuments | undefined,
  currentVersion: number,
  version: number,
) {
  if (version === currentVersion)
    throw new PersonaError("invalid", "현재 버전은 이미 적용되어 있습니다.");
  const selected = await versionOperation("persona.version.read", { personaVersion: version }, () =>
    store.version(record.id, version),
  );
  protect(selected.markdown);
  let sheet: ReturnType<typeof parseCharacterDescription>;
  try {
    sheet = parseCharacterDescription(selected.markdown);
  } catch (cause) {
    throw validationFailure(
      "Invalid rollback document",
      { stage: "persona.restore", code: "invalid_character" },
      cause,
    );
  }
  const restored = versionedPersona({
    ...record,
    name: sheet.name,
    gender: sheet.gender,
    description: selected.markdown,
    prompt: selected.markdown,
  });
  await operation(
    "persona.restore",
    { personaVersion: currentVersion + 1, restoredFrom: version },
    () =>
      store.save(restored, initial ?? { state: "", memory: "" }, {
        persona: draft.base,
        ...(initial && { initial }),
        restoredFrom: version,
      }),
  );
}

interface VersionContext {
  store: PersonaStore;
  tokens: ReturnType<typeof draftTokens>;
  drafts: Map<string, Draft>;
  busy: Set<string>;
  pending: (id: string) => string | undefined;
}

export async function versionRoutes(request: Request, url: URL, context: VersionContext) {
  const { store, tokens, drafts, busy, pending } = context;
  const match = /^\/personas\/([a-zA-Z0-9_-]+)\/versions(?:\/([1-9]\d*)\/restore)?$/.exec(
    url.pathname,
  );
  if (!match) return undefined;
  const id = match[1]!;
  requestFields({ personaId: id });
  let record: PersonaRecord | undefined;
  let draft: Draft | undefined;
  if (busy.has(id) || pending(id)) {
    const error = new PersonaError(
      "conflict",
      "진행 중인 작업이 끝난 뒤 버전을 확인하거나 복원해 주세요.",
    );
    return versionFailure(error, tokens);
  }
  busy.add(id);
  try {
    record = await store.get(id);
    const currentVersion = record.version ?? 1;
    const initial = await store.initial(id);
    if (request.method === "POST") {
      ({ record, draft } = await submittedVersion(
        request,
        url,
        store,
        tokens,
        record,
        Boolean(match[2]),
      ));
      if (dirty(draft))
        throw new PersonaError(
          "conflict",
          "저장 전 변경 사항이 있습니다. 먼저 저장한 뒤 버전 기록을 열어 주세요.",
        );
    } else {
      if (match[2]) throw new PersonaError("invalid", "복원은 확인한 POST 요청으로 실행해 주세요.");
      const source = serializePersona(record);
      draft = {
        id,
        base: source,
        preview: source,
        initial: initial ? { base: initial, preview: initial } : {},
      };
    }
    const cached = drafts.get(id);
    if (cached && cached.base === draft.base && dirty(cached))
      throw new PersonaError(
        "conflict",
        "저장 전 미리보기가 있습니다. 편집 화면에서 먼저 저장해 주세요.",
      );
    if (match[2]) {
      await restoreVersion(store, record, draft, initial, currentVersion, versionNumber(match[2]));
      drafts.delete(id);
      return new Response(null, { status: 303, headers: { Location: `/personas/${id}?saved=1` } });
    }
    const selectedNumber = versionNumber(url.searchParams.get("version") ?? String(currentVersion));
    const versions = await versionOperation("persona.versions", {}, () => store.versions(id));
    const selected = await versionOperation(
      "persona.version.read",
      { personaVersion: selectedNumber },
      () => store.version(id, selectedNumber),
    );
    return html(
      renderPage({
        personas: [],
        versionView: {
          current: record,
          currentVersion,
          versions,
          selected,
          draft: tokens.encode(draft),
        },
      }),
    );
  } catch (error) {
    return versionFailure(error, tokens, record, draft);
  } finally {
    busy.delete(id);
  }
}
