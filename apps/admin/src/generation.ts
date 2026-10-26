import { Schema } from "effect";
import type { JsonSchema } from "effect";
import type { Portrait, PersonaRecord, InitialDocuments } from "@ren-ai/personas";
import policy from "./policy.json";
import { GenerationError, operation, protect, safeText, validationFailure } from "./logging.ts";
import { generateCharacter, convertCharacter } from "./character-generation.ts";
import { generateInitialDocument } from "./initial-generation.ts";
import { profileWriting } from "./profile-writing.ts";
import sheetPolicy from "./identity-sheet-policy.json";
import { reserveGeneration, seedingBudgetActive } from "./seeding-budget.ts";
import { setTimeout } from "node:timers/promises";
import { networkError } from "./generation-network.ts";
import { codexImageModel } from "@ren-ai/image-generation";
import { codexImage } from "./codex-image.ts";

type Character = {
  readonly name: string;
  readonly description: string;
  readonly gender?: NonNullable<PersonaRecord["gender"]>;
};
const characterText = (character: Character) =>
  `${character.name}\n${character.description}${character.gender ? `\n\nSELECTED GENDER: ${character.gender}` : ""}`;
type PortraitStyle = keyof typeof policy.portraits;
export interface ProfileGenerator {
  sheet: (
    character: Character,
    style: PortraitStyle,
    instructions?: string,
    reference?: Portrait,
  ) => Promise<Portrait>;
  character: (
    seed: string,
    gender?: NonNullable<PersonaRecord["gender"]>,
  ) => Promise<Character & { initial: InitialDocuments }>;
  introduction: (character: Character) => Promise<string>;
  profile: (character: Character, instructions?: string) => Promise<string>;
  convert: (
    character: Character,
    instructions?: string,
  ) => Promise<Character & { additions: readonly string[] }>;
  state: (character: Character) => Promise<string>;
  memory: (character: Character) => Promise<string>;
  portrait: (
    character: Character,
    style: PortraitStyle,
    instructions?: string,
    reference?: Portrait,
    composition?: Portrait,
  ) => Promise<Portrait>;
}

const Part = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  thought: Schema.optionalKey(Schema.Boolean),
  inlineData: Schema.optionalKey(
    Schema.Struct({
      mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
      data: Schema.String,
    }),
  ),
});
const Reply = Schema.Struct({
  candidates: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        content: Schema.optionalKey(Schema.Struct({ parts: Schema.Array(Part) })),
        finishReason: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  promptFeedback: Schema.optionalKey(
    Schema.Struct({ blockReason: Schema.optionalKey(Schema.String) }),
  ),
});
const ProviderError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optionalKey(Schema.Number),
    status: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
  }),
});
const visibleText = (parts: readonly (typeof Part.Type)[]) =>
  parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();

async function readReply(response: Response, model: string, secrets: readonly string[]) {
  const fields = { model };
  if (!response.ok) {
    const detail = await response
      .json()
      .then(Schema.decodeUnknownSync(ProviderError))
      .catch(() => undefined);
    const error = detail?.error;
    throw new GenerationError(
      error?.message ? safeText(error.message, secrets) : "Profile generation failed",
      {
        ...fields,
        status: response.status,
        code: error?.code === undefined ? "http_error" : String(error.code),
        ...(error?.status && { providerStatus: safeText(error.status, secrets) }),
      },
    );
  }
  const reply = await response
    .json()
    .then(Schema.decodeUnknownSync(Reply))
    .catch((cause) => {
      throw validationFailure(
        "Invalid generation response",
        {
          ...fields,
          code: "invalid_response",
        },
        cause,
      );
    });
  const candidate = reply.candidates?.[0];
  const reasons = {
    ...fields,
    ...(candidate?.finishReason && { finishReason: safeText(candidate.finishReason, secrets) }),
    ...(reply.promptFeedback?.blockReason && {
      blockReason: safeText(reply.promptFeedback.blockReason, secrets),
    }),
  };
  if (!candidate?.content || reply.promptFeedback?.blockReason)
    throw new GenerationError("No generated content", { ...reasons, code: "no_content" });
  return { parts: candidate.content.parts.filter((part) => !part.thought), fields: reasons };
}

export function createProfileGenerator({
  key,
  endpoint = "https://generativelanguage.googleapis.com/v1beta",
  textModel = "gemini-3.8-flash",
  imageProvider = "gemini",
  imageModel = imageProvider === "codex" ? codexImageModel : "gemini-3.1-flash-image",
  codexKey = "",
  fetcher = fetch,
}: {
  key: string;
  endpoint?: string;
  textModel?: string;
  imageModel?: string;
  imageProvider?: string;
  codexKey?: string;
  fetcher?: typeof fetch;
}): ProfileGenerator {
  if (imageProvider !== "gemini" && imageProvider !== "codex")
    throw new Error("ADMIN_IMAGE_PROVIDER must be gemini or codex");
  if ((imageProvider === "codex") !== (imageModel === codexImageModel))
    throw new Error(
      "Codex requires gpt-image-2.5; remove ADMIN_IMAGE_MODEL when switching providers",
    );
  const thinkingConfig = { thinkingLevel: "LOW" };
  const configurations = {
    sheet: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "3:2", imageSize: "1K" },
    },
    image: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "4:5", imageSize: "1K" },
    },
    text: { maxOutputTokens: 8192, thinkingConfig },
    json: { maxOutputTokens: 8192, thinkingConfig, responseMimeType: "application/json" },
  };
  const request = async (
    model: string,
    prompt: string,
    input: string,
    format: keyof typeof configurations,
    style?: PortraitStyle,
    references: readonly Portrait[] = [],
    responseJsonSchema?: JsonSchema.JsonSchema,
  ) =>
    operation("generation.api", { model, ...(style && { style }) }, async () => {
      const imageParts = references.map((reference) => ({
        inlineData: {
          mimeType: reference.mimeType,
          data: Buffer.from(reference.bytes).toString("base64"),
        },
      }));
      const secrets = [key, prompt, input, ...imageParts.map((part) => part.inlineData.data)];
      protect(...secrets);
      const fields = { model };
      if (!key.trim())
        throw new GenerationError("GEMINI_API_KEY is required", { ...fields, code: "missing_key" });
      const dispatch = async () => {
        let response: Response;
        await reserveGeneration(model, `${prompt}\n\n${input}`, references.length);
        try {
          response = await fetcher(
            `${endpoint}/models/${encodeURIComponent(model)}:generateContent`,
            {
              method: "POST",
              headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
              signal: AbortSignal.timeout(120_000),
              body: JSON.stringify({
                contents: [
                  {
                    role: "user",
                    parts: [{ text: `${prompt}\n\n${input}` }, ...imageParts],
                  },
                ],
                generationConfig: {
                  ...configurations[format],
                  ...(seedingBudgetActive() && { maxOutputTokens: 8192 }),
                  ...(responseJsonSchema && { responseJsonSchema }),
                },
              }),
            },
          );
        } catch (cause) {
          throw networkError(cause, model, secrets);
        }
        return readReply(response, model, secrets);
      };
      for (let attempt = 0; ; attempt++) {
        try {
          return await dispatch();
        } catch (cause) {
          const rejected =
            cause instanceof GenerationError &&
            cause.fields.status === 429 &&
            cause.fields.providerStatus === "RESOURCE_EXHAUSTED";
          if (!seedingBudgetActive() || !rejected || attempt >= 2) throw cause;
          await operation("generation.rejected.wait", { model, status: cause.fields.status! }, () =>
            setTimeout(5000 * 2 ** attempt),
          );
        }
      }
    });
  const characterRequest = async (
    prompt: string,
    input: string,
    schema?: JsonSchema.JsonSchema,
  ) => {
    const { parts, fields } = await request(
      textModel,
      prompt,
      input,
      schema ? "json" : "text",
      undefined,
      [],
      schema,
    );
    return { text: visibleText(parts), fields };
  };
  const imageResult = async (
    prompt: string,
    input: string,
    style: PortraitStyle,
    references: readonly Portrait[],
    format: "image" | "sheet",
  ) => {
    if (imageProvider === "codex")
      return codexImage({
        key: codexKey,
        prompt: `${prompt}\n\n${input}`,
        references,
        format,
        style,
        fetcher,
      });
    const { parts, fields } = await request(imageModel, prompt, input, format, style, references);
    const image = parts.find((part) => part.inlineData)?.inlineData;
    if (!image) throw new GenerationError("No generated portrait", { ...fields, code: "no_image" });
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.toString("base64") !== image.data)
      throw new GenerationError("Invalid portrait encoding", {
        ...fields,
        code: "invalid_encoding",
      });
    return { bytes, mimeType: image.mimeType };
  };
  return {
    sheet: (character, style, instructions = "", reference) =>
      imageResult(
        `${sheetPolicy.direction}\n\n${sheetPolicy[style]}\n\n${policy.genderDirection}`,
        `${characterText(character)}${instructions ? `\n\nOPERATOR IDENTITY DIRECTION:\n${instructions}` : ""}`,
        style,
        reference ? [reference] : [],
        "sheet",
      ),
    character: (seed, gender) => generateCharacter(characterRequest, seed, gender),
    convert: (character, instructions) =>
      convertCharacter(characterRequest, character, instructions),
    state: (character) => generateInitialDocument(characterRequest, character.description, "state"),
    memory: (character) =>
      generateInitialDocument(characterRequest, character.description, "memory"),
    introduction: async (character) => {
      const { parts, fields } = await request(
        textModel,
        `${policy.introduction}\n\n${policy.genderDirection}`,
        characterText(character),
        "text",
      );
      const text = visibleText(parts);
      if (!text || text.length > 800)
        throw new GenerationError("Invalid introduction", {
          ...fields,
          code: "invalid_introduction",
        });
      return text;
    },
    profile: async (character, instructions = "") => {
      const { parts } = await request(
        textModel,
        `현재 공개 글과 운영자가 편집한 사실·말투를 기준으로 공개 프로필을 개선해. 운영자 요청 범위에서만 바꾸고 기존 항목을 중복 추가하지 마. 요청이 비어 있으면 부족한 정보와 구성을 보강해. 코드 블록이나 ## 공개 프로필 경계 없이 공개 Markdown만 반환해.\n${profileWriting}`,
        `${characterText(character)}\n\nIMPROVEMENT REQUEST:\n${instructions}`,
        "text",
      );
      return visibleText(parts);
    },
    portrait: async (character, style, instructions = "", reference, composition) => {
      return imageResult(
        (composition
          ? `${policy.portraits[style]}\n\n${policy.regeneratePortraitDirection}`
          : reference
            ? `${policy.portraits[style]}\n\n${policy.identityPortraitDirection}`
            : style === "photo"
              ? `${policy.portraits.photo}\n\n${policy.photoSceneDirection}`
              : policy.portraits.anime) +
          `\n\n${policy.profilePhotoDirection}\n\n${policy.genderDirection}`,
        `${characterText(character)}${instructions ? `\n\nADDITIONAL PORTRAIT INSTRUCTIONS:\n${instructions}` : ""}`,
        style,
        [reference, composition].filter((image): image is Portrait => image !== undefined),
        "image",
      );
    },
  };
}
