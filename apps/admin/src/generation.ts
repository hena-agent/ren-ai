import { Schema } from "effect";
import type { Portrait } from "@ren-ai/personas";
import policy from "./policy.json";

type Character = { readonly name: string; readonly description: string };
type PortraitStyle = keyof typeof policy.portraits;
export interface ProfileGenerator {
  character: (seed: string) => Promise<Character>;
  introduction: (character: Character) => Promise<string>;
  portrait: (character: Character, style: PortraitStyle) => Promise<Portrait>;
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
  candidates: Schema.Array(
    Schema.Struct({ content: Schema.Struct({ parts: Schema.Array(Part) }) }),
  ).check(Schema.isMinLength(1)),
});
const CharacterDraft = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/\S/)),
  description: Schema.String.check(Schema.isPattern(/\S/)),
});
const visibleText = (parts: readonly (typeof Part.Type)[]) =>
  parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();

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
    text: { maxOutputTokens: 1024, thinkingConfig },
    json: { maxOutputTokens: 4096, thinkingConfig, responseMimeType: "application/json" },
  };
  const request = async (
    model: string,
    prompt: string,
    input: string,
    format: "image" | "text" | "json",
  ) => {
    if (!key.trim()) throw new Error("GEMINI_API_KEY is required");
    const response = await fetcher(
      `${endpoint}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `${prompt}\n\n${input}` }],
            },
          ],
          generationConfig: configurations[format],
        }),
      },
    );
    if (!response.ok) throw new Error("Profile generation failed");
    return Schema.decodeUnknownSync(Reply)(
      await response.json(),
    ).candidates[0]!.content.parts.filter((part) => !part.thought);
  };
  return {
    character: async (seed) => {
      const parts = await request(textModel, policy.characterDraft, seed, "json");
      return Schema.decodeUnknownSync(CharacterDraft)(JSON.parse(visibleText(parts)));
    },
    introduction: async (character) => {
      const parts = await request(
        textModel,
        policy.introduction,
        `${character.name}\n${character.description}`,
        "text",
      );
      const text = visibleText(parts);
      if (!text || text.length > 240) throw new Error("Invalid introduction");
      return text;
    },
    portrait: async (character, style) => {
      const parts = await request(
        imageModel,
        policy.portraits[style],
        `${character.name}\n${character.description}`,
        "image",
      );
      const image = parts.find((part) => part.inlineData)?.inlineData;
      if (!image) throw new Error("No generated portrait");
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.toString("base64") !== image.data) throw new Error("Invalid portrait encoding");
      return { bytes, mimeType: image.mimeType };
    },
  };
}
