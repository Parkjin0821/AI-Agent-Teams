import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliAgentAdapter } from "./adapters.js";
import { Orchestrator } from "./orchestrator.js";
import { PersistentStore } from "./persistent-store.js";
import { ProjectWorkspaces } from './workspaces.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new PersistentStore({ dataDir: path.join(root, "data") });
const orchestrator = new Orchestrator({
  store,
  workspaces: new ProjectWorkspaces(path.join(root, 'projects')),
  adapter: new CliAgentAdapter({ enabled: process.env.AGENT_HQ_ENABLE_EXEC === "1", cwd: root }),
});

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      const html = await readFile(path.join(root, "outputs", "dashboard.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(html);
    }
    if (request.method === "GET" && url.pathname === "/api/state") return sendJson(response, 200, orchestrator.snapshot());
    if (request.method === "POST" && url.pathname === "/api/tasks") return sendJson(response, 202, await orchestrator.submit(await body(request)));
    const approval = url.pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/);
    if (request.method === "POST" && approval) return sendJson(response, 200, await orchestrator.approve(approval[1]));
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
      const unsubscribe = store.subscribe((event) => response.write(`data: ${JSON.stringify(event)}\n\n`));
      request.on("close", unsubscribe);
      return;
    }
    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
});

const port = Number(process.env.PORT || 4310);
server.listen(port, "127.0.0.1", () => console.log(`AGENT HQ http://localhost:${port}`));
