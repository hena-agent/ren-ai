import { Buffer } from "node:buffer";
import { Schema } from "effect";
import { ImageGenerationError, providerFailure, redactDiagnostic } from "./diagnostics.ts";

export { ImageGenerationError, providerFailure, redactDiagnostic } from "./diagnostics.ts";
export const codexImageModel = "gpt-image-2.5";

const Reply = Schema.Struct({
  data: Schema.Array(Schema.Struct({ b64_json: Schema.String })).check(
    Schema.isBetweenLength(1, 1),
  ),
});
const Failure = Schema.Struct({
  error: Schema.Struct({
    message: Schema.optionalKey(Schema.String),
    type: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

export async function codexImage({
  key,
  prompt,
  references,
  size,
  outputFormat,
  fetcher,
  beforeDispatch,
  signal,
}: {
  key: string;
  prompt: string;
  references: readonly { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp" }[];
  size: `${number}x${number}`;
  outputFormat: "png" | "jpeg";
  fetcher: typeof fetch;
  beforeDispatch?: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" }> {
  const model = codexImageModel;
  const image = references.map(
    (reference) =>
      `data:${reference.mimeType};base64,${Buffer.from(reference.bytes).toString("base64")}`,
  );
  const secrets = [key, prompt, ...image, ...image.map((value) => value.split(",")[1]!)];
  if (!key.trim())
    throw new ImageGenerationError("CODEX_IMAGE_API_KEY is required", {
      model,
      code: "missing_key",
    });
  if (prompt.length > 32000)
    throw new ImageGenerationError("Image prompt exceeds provider limit", {
      model,
      code: "prompt_limit",
    });
  await beforeDispatch?.();
  let response: Response;
  try {
    response = await fetcher(
      `https://codex-image.renai.im/v1/images/${image.length ? "edits" : "generations"}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        redirect: "manual",
        signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          size,
          response_format: "b64_json",
          output_format: outputFormat,
          ...(image.length > 0 && { image, input_fidelity: "high" }),
        }),
      },
    );
  } catch (cause) {
    throw providerFailure(cause, model, secrets);
  }
  if (!response.ok) {
    const failure = await response
      .json()
      .then(Schema.decodeUnknownSync(Failure))
      .catch(() => undefined);
    throw new ImageGenerationError(
      redactDiagnostic(failure?.error.message ?? "Image generation failed", secrets),
      {
        model,
        status: response.status,
        code: redactDiagnostic(failure?.error.code ?? "http_error", secrets),
        ...(failure?.error.type && {
          providerStatus: redactDiagnostic(failure.error.type, secrets),
        }),
      },
    );
  }
  const reply = await response
    .json()
    .then(Schema.decodeUnknownSync(Reply))
    .catch((cause) => {
      throw providerFailure(cause, model, secrets, true);
    });
  const encoded = reply.data[0]!.b64_json;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 20_000_000 || bytes.toString("base64") !== encoded)
    throw new ImageGenerationError("Invalid portrait encoding or size", {
      model,
      code: "invalid_encoding",
    });
  const mimeType = outputFormat === "png" ? "image/png" : "image/jpeg";
  return { bytes, mimeType };
}
