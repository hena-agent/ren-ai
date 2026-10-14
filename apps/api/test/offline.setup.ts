import { Socket } from "node:net";
import { afterEach, vi } from "vitest";

const fetchNetwork = globalThis.fetch;
// oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the original Socket as this.
const connectNetwork = Socket.prototype.connect;
export const local = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);

const guardedFetch = vi.fn<typeof fetch>((input, init) => {
  const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
  if (!local(host)) return Promise.reject(new Error(`Offline test: fetch blocked for ${host}`));
  return fetchNetwork(input, init);
});
vi.stubGlobal("fetch", guardedFetch);
afterEach(() => vi.stubGlobal("fetch", guardedFetch));

vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
  this: Socket,
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: Node socket overloads are narrowed before allowing a connection.
  ...args: unknown[]
) {
  const target = args[0];
  let host: string | undefined;
  if (typeof target === "number") host = typeof args[1] === "string" ? args[1] : "localhost";
  if (typeof target === "object" && target !== null && "port" in target)
    host = "host" in target && typeof target.host === "string" ? target.host : "localhost";
  if (host !== undefined && !local(host))
    throw new Error(`Offline test: socket blocked for ${host}`);
  Reflect.apply(connectNetwork, this, args);
  return this;
});
