import { PersonaError, serializePersona } from "@ren-ai/personas";
import type { PersonaStore } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import { draftTokens } from "./draft.ts";
import { operation, requestFields } from "./logging.ts";
import type { renderPage } from "./page.tsx";

async function downloadDocument(store: PersonaStore, id: string, kind: string) {
  requestFields({ personaId: id });
  let source: string;
  if (kind === "persona") source = serializePersona(await store.get(id));
  else {
    const initial = await store.initial(id);
    if (!initial) throw new PersonaError("not_found", "저장된 초기 문서가 없습니다.");
    source = initial[kind === "state" ? "state" : "memory"];
  }
  return new Response(source, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${kind === "persona" ? kind : kind.toUpperCase()}.md"`,
      "Cache-Control": "no-store",
    },
  });
}

export function createResources(
  store: PersonaStore,
  tokens: ReturnType<typeof draftTokens>,
  localImages: boolean,
  render: (content: Parameters<typeof renderPage>[0]) => Response,
  recovery?: () => Promise<Response>,
) {
  return async (pathname: string) => {
    if (pathname === "/editing-recovery" && recovery)
      return operation("editing.recovery.download", {}, recovery);
    const document = /^\/personas\/([a-zA-Z0-9_-]+)\/(persona|state|memory)\.md$/.exec(pathname);
    if (document) return downloadDocument(store, document[1]!, document[2]!);
    const importing = /^\/import\/([a-zA-Z0-9_-]+)$/.exec(pathname);
    if (importing) {
      const imported = await store.importDraft(importing[1]!);
      const initial = await store.initial(importing[1]!);
      const draft: Draft = {
        id: importing[1]!,
        base: serializePersona(imported.persona),
        preview: serializePersona(imported.persona),
        legacySource: imported.original,
        initial: initial ? { base: initial, preview: initial } : {},
      };
      return render({
        record: imported.persona,
        editing: true,
        draft: tokens.encode(draft),
        documents: initial,
      });
    }
    if (localImages && pathname.startsWith("/images/"))
      return operation("image.read", {}, () => store.image(pathname.slice("/images/".length)));
    return undefined;
  };
}
