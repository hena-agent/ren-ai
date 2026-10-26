import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { remoteMessages } from "@ren-ai/imsg/client";
import { validatePortrait } from "@ren-ai/personas";
import { conversationHistory } from "./messages.ts";
import { conversationRequest } from "./http.ts";

type Messages = Pick<Effect.Success<ReturnType<typeof remoteMessages>>, "history" | "image">;

function imageQuery(url: string) {
  const query = new URL(url).searchParams;
  const id = Number(query.get("id"));
  const messageID = Number(query.get("message"));
  const index = Number(query.get("attachment"));
  const guid = query.get("guid");
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(messageID) ||
    messageID <= 0 ||
    messageID >= Number.MAX_SAFE_INTEGER ||
    !query.has("attachment") ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !guid
  )
    return undefined;
  return { id, messageID, index, guid };
}

/** The caller must apply the application's operator authentication boundary. */
export const conversationImageRequest = (
  request: Request,
  messages: Messages,
  run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>,
) =>
  conversationRequest(request, async () => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const query = imageQuery(request.url);
    if (!query) return new Response(null, { status: 400 });
    const { id, messageID, index, guid } = query;
    const history = await run(conversationHistory(messages, id, messageID + 1));
    const row = history?.entries.find((entry) => entry.id === messageID && entry.guid === guid);
    const attachment = row?.attachments?.[index];
    if (
      !row?.fromMe ||
      (row.status?.state !== "sent" && row.status?.state !== "delivered") ||
      !attachment ||
      attachment.missing ||
      !attachment.mimeType?.startsWith("image/")
    )
      return new Response(null, { status: 404 });
    const { uri } = await run(messages.image(attachment));
    const match = /^data:([^;]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
    if (!match || match[2]!.length > Math.ceil(20_000_000 / 3) * 4)
      throw new Error("Invalid Conversation image response");
    const mimeType = match[1];
    if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp")
      throw new Error("Invalid Conversation image type");
    const bytes = Buffer.from(match[2]!, "base64");
    validatePortrait({ bytes, mimeType });
    return new Response(bytes, {
      headers: { "Content-Type": mimeType, "X-Content-Type-Options": "nosniff" },
    });
  });
