import { Schema } from "effect";
import type { Portrait } from "@ren-ai/personas";
import { GenerationError, operation, protect, safeText, validationFailure } from "./logging.ts";
import { networkError } from "./generation-network.ts";
import { reserveGeneration } from "./seeding-budget.ts";

export const arenaImageModel = "gpt-image-2.5-sunburst";
const Reply = Schema.Struct({
  data: Schema.Array(Schema.Struct({ b64_json: Schema.String })).check(
    Schema.isLengthBetween(1, 1),
  ),
});
const Failure = Schema.Struct({
  error: Schema.Struct({
    message: Schema.optionalKey(Schema.String),
    type: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

export async function arenaImage({
  key,
  model,
  prompt,
  references,
  format,
  style,
  fetcher,
}: {
  key: string;
  model: string;
  prompt: string;
  references: readonly Portrait[];
  format: "sheet" | "image";
  style: string;
  fetcher: typeof fetch;
}): Promise<Portrait> {
  return operation("generation.api", { model, style }, async () => {
    const image = references.map(
      (reference) =>
        `data:${reference.mimeType};base64,${Buffer.from(reference.bytes).toString("base64")}`,
    );
    const secrets = [key, prompt, ...image, ...image.map((value) => value.split(",")[1]!)];
    protect(...secrets);
    if (!key.trim())
      throw new GenerationError("ARENA_IMAGE_API_KEY is required", { model, code: "missing_key" });
    if (prompt.length > 32000)
      throw new GenerationError("Image prompt exceeds provider limit", {
        model,
        code: "prompt_limit",
      });
    await reserveGeneration(model, prompt, references.length);
    let response: Response;
    try {
      response = await fetcher(
        `https://gpt-image.renai.im/v1/images/${image.length ? "edits" : "generations"}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(120_000),
          body: JSON.stringify({
            model,
            prompt,
            n: 1,
            size: format === "sheet" ? "1536x1024" : "1024x1280",
            response_format: "b64_json",
            output_format: "png",
            ...(image.length > 0 && { image, input_fidelity: "high" }),
          }),
        },
      );
    } catch (cause) {
      throw networkError(cause, model, secrets);
    }
    if (!response.ok) {
      const failure = await response
        .json()
        .then(Schema.decodeUnknownSync(Failure))
        .catch(() => undefined);
      throw new GenerationError(
        safeText(failure?.error.message ?? "Image generation failed", secrets),
        {
          model,
          status: response.status,
          code: safeText(failure?.error.code ?? "http_error", secrets),
          ...(failure?.error.type && { providerStatus: safeText(failure.error.type, secrets) }),
        },
      );
    }
    const reply = await response
      .json()
      .then(Schema.decodeUnknownSync(Reply))
      .catch((cause) => {
        throw validationFailure(
          "Invalid image response",
          { model, code: "invalid_response" },
          cause,
        );
      });
    const encoded = reply.data[0]!.b64_json;
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > 20_000_000 || bytes.toString("base64") !== encoded)
      throw new GenerationError("Invalid portrait encoding or size", {
        model,
        code: "invalid_encoding",
      });
    return { bytes, mimeType: "image/png" };
  });
}
