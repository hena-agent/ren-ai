import type { Portrait } from "@ren-ai/personas";
import { imageProviders, type ImageModelSelection } from "./image-model.ts";

export function imageModelRequest(
  selection: ImageModelSelection,
  key: string,
  prompt: string,
  reference: Portrait,
) {
  const image = `data:${reference.mimeType};base64,${Buffer.from(reference.bytes).toString("base64")}`;
  const base = imageProviders[selection.provider].base;
  const headers = { Authorization: `Bearer ${key}` };
  const json = (url: string, body: object, authentication: Record<string, string> = headers) => ({
    url,
    headers: { ...authentication, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (selection.provider === "fal") {
    const fields = new Set(selection.fields);
    return json(
      `${base}/${selection.model}`,
      {
        prompt,
        [selection.referenceField]: selection.referenceField === "image_urls" ? [image] : image,
        ...(selection.size === "pixels" && { image_size: { width: 1664, height: 2432 } }),
        ...(selection.size === "ratio" && { aspect_ratio: "2:3" }),
        num_images: 1,
        ...(fields.has("max_images") && { max_images: 1 }),
        ...(fields.has("sequential_image_generation") && {
          sequential_image_generation: "disabled",
        }),
        ...(fields.has("output_format") && { output_format: selection.outputFormat }),
        sync_mode: true,
      },
      { Authorization: `Key ${key}` },
    );
  }
  if (selection.provider === "google")
    return json(
      `${base}/models/${encodeURIComponent(selection.model)}:generateContent`,
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: reference.mimeType,
                  data: Buffer.from(reference.bytes).toString("base64"),
                },
              },
            ],
          },
        ],
        generationConfig: {
          candidateCount: 1,
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: "2:3" },
        },
      },
      { "x-goog-api-key": key },
    );
  if (selection.provider === "openrouter")
    return json(`${base}/images`, {
      model: selection.model,
      prompt,
      n: 1,
      aspect_ratio: "2:3",
      output_format: selection.outputFormat,
      input_references: [{ type: "image_url", image_url: { url: image } }],
      provider: { allow_fallbacks: false },
    });
  const form = new FormData();
  for (const [name, value] of Object.entries({
    model: selection.model,
    prompt,
    n: "1",
    size: "1024x1536",
    output_format: selection.outputFormat,
  }))
    form.set(name, value);
  form.set(
    "image[]",
    new Blob([new Uint8Array(reference.bytes)], { type: reference.mimeType }),
    `identity-sheet.${reference.mimeType === "image/jpeg" ? "jpg" : reference.mimeType.split("/")[1]}`,
  );
  return { url: `${base}/images/edits`, headers, body: form };
}
