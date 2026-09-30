import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchProxy } from "../src/operations/proxy-patch.ts";

// Reviewed proxy seams, kept executable so HTTP and WS credential forwarding are checked.
export const proxyFixture = `
const basicAuthHeader = () => "Basic privileged";
const verifyToken = (cookie) => cookie === "browser";
const COOKIE_NAME = "oc_session";
const parseCookies = req => ({ oc_session: req.headers.get("cookie") });
const OPENCODE_HTTP = process.env.UPSTREAM;
const OPENCODE_WS = OPENCODE_HTTP.replace("http", "ws");
let passwordReads = 0;
const getUpstreamPassword = () => { passwordReads++; return "password"; };
let cachedPassword = "password";
async function proxyOnce(req, url, retried = false) {
  const headers = new Headers(req.headers);
  headers.delete("cookie");
  headers.delete("host");
  headers.set("authorization", basicAuthHeader());
  const resp = await fetch(OPENCODE_HTTP + url.pathname, { headers });
  if (resp.status === 401 && !retried) {
    cachedPassword = getUpstreamPassword();
    return proxyOnce(req, url, true);
  }
  return new Response(await resp.text(), { status: resp.status, headers: { "password-reads": String(passwordReads) } });
}
type WSData = { target: string; upstream?: WebSocket; queue: (string | Uint8Array)[] };
const server = Bun.serve<WSData>({ port: 0, hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    const cookies = parseCookies(req);
    const authed = verifyToken(cookies[COOKIE_NAME]);
    if (!authed) return new Response("Unauthorized", { status: 401 });
    if (req.headers.get("upgrade") === "websocket") {
      if (srv.upgrade(req, { data: { target: url.pathname + url.search, queue: [] } })) return;
    }
    return proxyOnce(req, url);
  },
  websocket: {
    open(ws) {
      const upstream = new WebSocket(OPENCODE_WS + ws.data.target, {
        headers: { Authorization: basicAuthHeader() },
      });
      ws.data.upstream = upstream;
      upstream.addEventListener("error", () => ws.close());
      upstream.addEventListener("close", () => ws.close());
    },
    message() {}, close(ws) { ws.data.upstream?.close(); }
  }
});
console.log(server.url.href);
`;

export const proxyBoundary = async () => {
  const received: Array<{
    authorization: string | undefined;
    cookie: string | undefined;
    ws: boolean;
  }> = [];
  const upstream = createServer((req, res) => {
    received.push({
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      ws: false,
    });
    res.writeHead(
      req.headers.authorization === "Basic privileged" ||
        req.headers.authorization === "Basic valid"
        ? 200
        : 401,
    );
    res.end("native server");
  });
  upstream.on("upgrade", (req, socket) => {
    received.push({
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      ws: true,
    });
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No upstream port");
  const root = await mkdtemp(join(tmpdir(), "ren-ai-proxy-"));
  const file = join(root, "proxy.ts");
  await writeFile(file, patchProxy(proxyFixture));
  const child = spawn("bun", [file], {
    env: { ...process.env, UPSTREAM: `http://127.0.0.1:${address.port}` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise<string>((resolve) => {
    child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString().trim()));
  });
  return {
    url,
    received,
    close: async () => {
      child.kill();
      await once(child, "exit");
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
};
