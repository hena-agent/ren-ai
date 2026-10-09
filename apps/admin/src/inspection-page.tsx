import type { createPersonaStore } from "@ren-ai/personas";
import { inspectPersona } from "./character-format.ts";
import { GenerationError, reportFailure } from "./logging.ts";

type Files = Awaited<ReturnType<Awaited<ReturnType<typeof createPersonaStore>>["inspect"]>>;
export function inspectFiles(files: Files) {
  return files.map((file) => {
    if (file.error) {
      const error = new GenerationError("Cannot inspect persona file", {
        code: file.error,
        causeName: file.causeName,
        ...(file.causeCode && { causeCode: file.causeCode }),
        durationMs: file.durationMs,
      });
      error.stack = file.stack;
      reportFailure(error, {
        stage: "persona.inspect.file",
        personaId: file.id,
      });
      return {
        id: file.id,
        name: file.id,
        status: "file-error",
        message: "파일 오류 · 해당 Persona 파일을 수정해 주세요.",
        profileNeeded: false,
        importRequired: false,
      };
    }
    return {
      id: file.id,
      name: file.persona.name,
      ...inspectPersona(file.persona),
      importRequired: file.legacySource !== undefined,
    };
  });
}
export type InspectionRow = ReturnType<typeof inspectFiles>[number];
const labels: Readonly<Record<string, string>> = {
  current: "최신 형식",
  convert: "변환 필요",
  repair: "수정 필요",
  "file-error": "파일 오류",
};
export function InspectionResults({ rows }: { rows: readonly InspectionRow[] }) {
  return (
    <section aria-label="Persona 검사 결과" className="inspection-results">
      <p className="hint">
        AI 호출 없이 형식과 공개 정보 상태를 확인합니다. 한 파일의 오류는 다른 검사를 막지 않습니다.
      </p>
      {rows.length ? (
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              <div>
                <strong>{row.name}</strong>
                <span className="badge">{labels[row.status]}</span>
              </div>
              <p>{row.message}</p>
              {row.profileNeeded && <p className="hint">공개 정보 생성 필요</p>}
              {row.status !== "file-error" && (
                <a href={`${row.importRequired ? "/import" : "/personas"}/${row.id}`}>
                  열어서 확인·변환 →
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>검사할 Persona가 없습니다.</p>
      )}
    </section>
  );
}
