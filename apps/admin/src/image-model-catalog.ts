import { Schema } from "effect";
import { PersonaError } from "@ren-ai/personas";
import {
  ImageModelSelection,
  imageModelId,
  type ImageConnections,
  type ImageModels,
  type ImageModelEntry,
} from "./image-model.ts";
import { modelsDevEntries, nativeSelection } from "./image-model-source.ts";
import { falEntries, falSelection } from "./fal-model-catalog.ts";
import { privateTokens } from "./private-token.ts";
import { validationFailure } from "./logging.ts";

function memo<T>() {
  const entries = new Map<string, { until: number; value: Promise<T> }>();
  return {
    clear: () => entries.clear(),
    get: (key: string, load: () => Promise<T>) => {
      const saved = entries.get(key);
      if (saved && saved.until > Date.now()) return saved.value;
      if (entries.size >= 50) entries.delete(entries.keys().next().value!);
      const value: Promise<T> = load().catch((error) => {
        if (entries.get(key)?.value === value) entries.delete(key);
        throw error;
      });
      entries.set(key, { until: Date.now() + 300_000, value });
      return value;
    },
  };
}

export function createImageModelCatalog(
  connections: ImageConnections,
  password: string,
  fetcher = fetch,
): ImageModels {
  const native = memo<ImageModelEntry[]>();
  const fal = memo<Awaited<ReturnType<typeof falEntries>>>();
  const choices = memo<ImageModelSelection>();
  const tokens = privateTokens(password);
  return {
    list: async (query, cursor, refresh) => {
      if (refresh) {
        native.clear();
        fal.clear();
        choices.clear();
      }
      const [common, hosted] = await Promise.allSettled([
        native.get("models.dev", () => modelsDevEntries(connections, fetcher)),
        fal.get(JSON.stringify([query, cursor]), () =>
          falEntries(connections.fal, fetcher, query, cursor),
        ),
      ]);
      const models = common.status === "fulfilled" ? common.value : [];
      const searched = query.toLocaleLowerCase();
      const found = models.filter((model) =>
        `${model.name} ${model.providerName} ${model.id}`.toLocaleLowerCase().includes(searched),
      );
      if (hosted.status === "fulfilled") found.push(...hosted.value.models);
      const unique = [...new Map(found.map((entry) => [entry.id, entry])).values()];
      unique.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.id.localeCompare(b.id));
      return {
        models: unique,
        nextCursor: hosted.status === "fulfilled" ? hosted.value.nextCursor : null,
        errors: [
          ...(common.status === "rejected" ? ["models.dev 카탈로그를 읽지 못했습니다."] : []),
          ...(hosted.status === "rejected" ? ["fal 카탈로그를 읽지 못했습니다."] : []),
        ],
      };
    },
    resolve: (id) =>
      choices.get(id, async () => {
        const separator = id.indexOf(":");
        const provider = id.slice(0, separator);
        const model = id.slice(separator + 1);
        try {
          if (separator <= 0 || imageModelId(provider, model) !== id)
            throw new Error("Invalid identifier");
        } catch {
          throw new PersonaError("invalid", "모델 카탈로그에서 모델을 선택하세요.");
        }
        if (provider === "fal") return falSelection(model, connections.fal, fetcher);
        const models = await native.get("models.dev", () => modelsDevEntries(connections, fetcher));
        const entry = models.find((candidate) => candidate.id === id);
        if (!entry) throw new PersonaError("invalid", "현재 카탈로그에 없는 모델입니다.");
        return nativeSelection(entry);
      }),
    quote: (selection) => tokens.encode(JSON.stringify(selection)),
    selected: (quote, id) => {
      if (typeof id !== "string") throw new PersonaError("invalid", "이미지 모델을 선택하세요.");
      let selection: ImageModelSelection;
      try {
        selection = Schema.decodeUnknownSync(ImageModelSelection)(JSON.parse(tokens.decode(quote)));
      } catch (cause) {
        if (cause instanceof PersonaError) throw cause;
        throw validationFailure(
          "Invalid image model selection",
          { code: "invalid_model_selection" },
          cause,
        );
      }
      if (selection.id !== id || imageModelId(selection.provider, selection.model) !== id)
        throw new PersonaError("invalid", "확인한 이미지 모델과 요청이 일치하지 않습니다.");
      return selection;
    },
  };
}
