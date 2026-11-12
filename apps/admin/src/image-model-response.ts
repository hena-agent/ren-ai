import { Schema } from "effect";
import { validatePortrait, type Portrait } from "@ren-ai/personas";
import type { ImageProvider } from "./image-model.ts";

const Mime = Schema.Literals(["image/png", "image/jpeg", "image/webp"]);
const Inline = Schema.Struct({ data: Schema.String, mimeType: Mime });
const GoogleReply = Schema.Struct({
  candidates: Schema.Array(
    Schema.Struct({
      content: Schema.Struct({
        parts: Schema.Array(
          Schema.Struct({
            thought: Schema.optionalKey(Schema.Boolean),
            inlineData: Schema.optionalKey(Inline),
          }),
        ),
      }),
    }),
  ),
});
const FalReply = Schema.Struct({
  images: Schema.Array(Schema.Struct({ url: Schema.String })).check(Schema.isBetweenLength(1, 1)),
});
const DataReply = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ b64_json: Schema.String, media_type: Schema.optionalKey(Mime) }),
  ).check(Schema.isBetweenLength(1, 1)),
});

function decodedImage(encoded: string, mimeType: typeof Mime.Type): Portrait {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("Invalid image encoding");
  const image = { bytes, mimeType };
  validatePortrait(image);
  return image;
}

export async function imageModelResponse(
  response: Response,
  provider: ImageProvider,
  outputFormat: "png" | "jpeg" | "webp",
): Promise<Portrait> {
  if (provider === "fal") {
    const reply = Schema.decodeUnknownSync(FalReply)(await response.json());
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/.exec(reply.images[0]!.url);
    if (!match) throw new Error("Expected inline image result");
    return decodedImage(match[2]!, Schema.decodeUnknownSync(Mime)(match[1]));
  }
  if (provider === "google") {
    const reply = Schema.decodeUnknownSync(GoogleReply)(await response.json());
    const images = reply.candidates.flatMap((candidate) =>
      candidate.content.parts.flatMap((part) =>
        part.inlineData && !part.thought ? [part.inlineData] : [],
      ),
    );
    if (images.length !== 1) throw new Error("Expected exactly one generated image");
    return decodedImage(images[0]!.data, images[0]!.mimeType);
  }
  const reply = Schema.decodeUnknownSync(DataReply)(await response.json()).data[0]!;
  return decodedImage(
    reply.b64_json,
    provider === "openai"
      ? ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const)[outputFormat]
      : Schema.decodeUnknownSync(Mime)(reply.media_type),
  );
}
