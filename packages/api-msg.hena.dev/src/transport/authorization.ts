import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

export const authorize = (handler: (request: Request) => Promise<Response>, token: string) => {
  if (!token) throw new Error("Service authorization token is required");
  const expected = digest(`Bearer ${token}`);
  return (request: Request) => {
    const provided = request.headers.get("authorization");
    return provided !== null && timingSafeEqual(expected, digest(provided))
      ? handler(request)
      : Promise.resolve(new Response("Unauthorized", { status: 401 }));
  };
};
