import { Buffer } from "node:buffer";
import { Schema } from "effect";
import { SocialID } from "@ren-ai/onboarding/social";
import type { SocialClient } from "./social-client.ts";
import { PersonaError } from "@ren-ai/personas";

export async function socialImageResponse(request: Request, client: SocialClient | undefined) {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if (!client) throw new PersonaError("invalid", "소셜 API 연결 설정이 필요합니다.");
  const path = new URL(request.url).pathname.split("/");
  const input = Schema.decodeUnknownSync(Schema.Struct({ accountId: SocialID, imageId: SocialID }))(
    { accountId: path[3], imageId: path[4] },
  );
  const image = await client.image(input.accountId, input.imageId);
  return new Response(Buffer.from(image.data, "base64"), {
    headers: {
      "Content-Type": image.mime,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
