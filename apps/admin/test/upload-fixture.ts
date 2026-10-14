import { crc32, deflateSync } from "node:zlib";
import { authorization, character } from "./fixtures.ts";

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}
export function croppedPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1024);
  header.writeUInt32BE(1280, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((1024 * 3 + 1) * 1280))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function uploadRequest(
  token: string,
  query = "style=photo",
  image: Blob | string = new Blob([croppedPng()], { type: "image/png" }),
) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...character, draft: token })) form.set(key, value);
  form.set("image", image);
  return new Request(`http://localhost:3729/upload-image?${query}`, {
    method: "POST",
    headers: { authorization, origin: "http://localhost:3729" },
    body: form,
  });
}
