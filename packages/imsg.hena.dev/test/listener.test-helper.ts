import type { Server } from "node:http";

export const listenerUrl = (server: Server) => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
};
