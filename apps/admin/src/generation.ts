import { Schema } from "effect";
import type { JsonSchema } from "effect";
import type { Portrait, PersonaRecord, InitialDocuments } from "@ren-ai/personas";
import policy from "./policy.json";
import { GenerationError, operation, protect, safeText, validationFailure } from "./logging.ts";
import { generateCharacter, convertCharacter } from "./character-generation.ts";
import { generateInitialDocument } from "./initial-generation.ts";

type Character = {
  readonly name: string;
  readonly description: string;
  readonly gender?: NonNullable<PersonaRecord["gender"]>;
};
const characterText = (character: Character) =>
  `${character.name}\n${character.description}${character.gender ? `\n\nSELECTED GENDER: ${character.gender}` : ""}`;
type PortraitStyle = keyof typeof policy.portraits;
export interface ProfileGenerator {
  character: (
    seed: string,
    gender?: NonNullable<PersonaRecord["gender"]>,
  ) => Promise<Character & { initial: InitialDocuments }>;
  introduction: (character: Character) => Promise<string>;
  profile: (character: Character) => Promise<string>;
  convert: (character: Character) => Promise<Character & { additions: readonly string[] }>;
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

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow fetch failures, including their underlying transport cause
function networkError(cause: unknown, model: string, secrets: readonly string[]) {
  const error = cause instanceof Error ? cause : new Error("Generation network failure");
  const root = error.cause instanceof Error ? error.cause : error;
  const diagnostic = new GenerationError(safeText(root.message, secrets), {
    model,
    code:
      error.name === "TimeoutError"
        ? "timeout"
        : error.name === "AbortError"
          ? "aborted"
          : "network_error",
    causeName: safeText(root.name, secrets),
    ...("code" in root &&
      typeof root.code === "string" && { causeCode: safeText(root.code, secrets) }),
  });
  if (root.stack) diagnostic.stack = root.stack;
  return diagnostic;
}

export function createProfileGenerator({
  key,
  endpoint = "https://generativelanguage.googleapis.com/v1beta",
  textModel = "gemini-3.8-flash",
  imageModel = "gemini-3.1-flash-image",
  fetcher = fetch,
}: {
  key: string;
  endpoint?: string;
  textModel?: string;
  imageModel?: string;
  fetcher?: typeof fetch;
}): ProfileGenerator {
  const thinkingConfig = { thinkingLevel: "LOW" };
  const configurations = {
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
    format: "image" | "text" | "json",
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
      let response: Response;
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
                ...(responseJsonSchema && { responseJsonSchema }),
              },
            }),
          },
        );
      } catch (cause) {
        throw networkError(cause, model, secrets);
      }
      return readReply(response, model, secrets);
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
  return {
    character: (seed, gender) => generateCharacter(characterRequest, seed, gender),
    convert: (character) => convertCharacter(characterRequest, character),
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
    profile: async (character) => {
      const { parts } = await request(
        textModel,
        "이 Persona가 실제 데이팅 프로필에 올릴 공개 Markdown만 작성해. 첫 문단은 짧은 1인칭 자기소개 필수. 나머지는 그 사람이 원하는 제목·문단·목록·문답을 자유롭게 고르고 ### 제목부터 써. 모든 항목을 채우지 마. 원래 공개하지 않은 취미·개인 정보는 비어 있어도 정상이며 요청 없이 보충하지 마. 내부 수치·숨겨진 특성·생성 지침·상대와의 기억은 공개하지 마. 코드 블록이나 ## 공개 프로필 경계 없이 공개 내용만 반환해.",
        characterText(character),
        "text",
      );
      return visibleText(parts);
    },
    portrait: async (character, style, instructions = "", reference, composition) => {
      const { parts, fields } = await request(
        imageModel,
        (composition
          ? `${policy.portraits[style]}\n\n${policy.regeneratePortraitDirection}`
          : reference
            ? `${policy.portraits[style]}\n\n${policy.subPortraitDirection}`
            : style === "photo"
              ? `${policy.portraits.photo}\n\n${policy.photoSceneDirection}`
              : policy.portraits.anime) +
          `\n\n${policy.profilePhotoDirection}\n\n${policy.genderDirection}`,
        `${characterText(character)}${instructions ? `\n\nADDITIONAL PORTRAIT INSTRUCTIONS:\n${instructions}` : ""}`,
        "image",
        style,
        [reference, composition].filter((image): image is Portrait => image !== undefined),
      );
      const image = parts.find((part) => part.inlineData)?.inlineData;
      if (!image)
        throw new GenerationError("No generated portrait", { ...fields, code: "no_image" });
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.toString("base64") !== image.data)
        throw new GenerationError("Invalid portrait encoding", {
          ...fields,
          code: "invalid_encoding",
        });
      return { bytes, mimeType: image.mimeType };
    },
  };
}
