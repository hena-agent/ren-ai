#!/usr/bin/env node
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv
  .find((arg) => arg.startsWith("--user-data-dir="))
  .slice("--user-data-dir=".length);
const target = "/devtools/browser/test-canary";
const server = createServer((request, response) => {
  if (request.url === "/exit") {
    response.end();
    server.close();
    server.closeAllConnections();
    return;
  }
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}${target}` }),
  );
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(join(directory, "DevToolsActivePort"), `${server.address().port}\n${target}\n`);
});
