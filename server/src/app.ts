import { randomUUID } from "node:crypto";
import { READING_NEST_APP_VERSION } from "@ss/shared";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { NextFunction, Request, Response } from "express";
import { createMcpServer } from "./mcp/create-server.js";

type TransportMap = Record<string, StreamableHTTPServerTransport>;
const widgetPath = fileURLToPath(new URL("../../web/dist/index.html", import.meta.url));
let cachedWidgetAssets:
  | {
      script: string;
      style: string;
      scriptGzip: Buffer;
      styleGzip: Buffer;
    }
  | undefined;

export function createApp() {
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  const transports: TransportMap = {};
  app.use(validateDevelopmentHost);

  app.get("/health", (_request, response) => {
    response.set("cache-control", "no-store");
    response.json({
      ok: true,
      app: "阿雾和陆沉的共读小巢",
      version: READING_NEST_APP_VERSION
    });
  });

  app.get("/app-assets/widget.js", async (_request, response) => {
    const assets = await readWidgetAssets();
    sendCompressedAsset(_request, response, assets.script, assets.scriptGzip, "text/javascript");
  });

  app.get("/app-assets/widget.css", async (_request, response) => {
    const assets = await readWidgetAssets();
    sendCompressedAsset(_request, response, assets.style, assets.styleGzip, "text/css");
  });

  app.post("/mcp", async (request: Request, response: Response) => {
    try {
      const sessionId = request.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports[sessionId] : undefined;

      if (!transport && !sessionId && isInitializeRequest(request.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (createdSessionId) => {
            transports[createdSessionId] = transport!;
          }
        });
        transport.onclose = () => {
          if (transport?.sessionId) delete transports[transport.sessionId];
        };
        const publicOrigin = getPublicOrigin(request);
        await (
          await createMcpServer(undefined, {
            workerOrigin: publicOrigin,
            sourceEndpointBase: publicOrigin,
            lightweightSchemas: isTunnelOrigin(publicOrigin)
          })
        ).connect(transport);
      }

      if (!transport) {
        response.status(400).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Invalid or missing MCP session ID" }
        });
        return;
      }
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" }
        });
      }
    }
  });

  app.get("/mcp", async (request: Request, response: Response) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) return response.status(400).send("Invalid or missing MCP session ID");
    await transport.handleRequest(request, response);
  });

  app.delete("/mcp", async (request: Request, response: Response) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) return response.status(400).send("Invalid or missing MCP session ID");
    await transport.handleRequest(request, response);
  });

  app.use(proxyViteDevelopmentAsset);

  return app;
}

function validateDevelopmentHost(request: Request, response: Response, next: NextFunction) {
  const hostname = parseHostname(request.headers.host);
  if (hostname && isAllowedHost(hostname)) return next();
  response.status(403).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: hostname ? `Invalid Host: ${hostname}` : "Missing or invalid Host header"
    },
    id: null
  });
}

function parseHostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
}

function isAllowedHost(hostname: string): boolean {
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return true;
  if (hostname.endsWith(".trycloudflare.com")) return true;
  return allowedHostsFromEnv().includes(hostname);
}

function allowedHostsFromEnv(): string[] {
  return (process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

function getPublicOrigin(request: Request): string {
  const forwardedProto = headerValue(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto ?? request.protocol;
  const host = request.headers.host ?? "localhost:8787";
  return `${proto}://${host}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isTunnelOrigin(origin: string): boolean {
  try {
    return new URL(origin).hostname.endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}

async function proxyViteDevelopmentAsset(
  request: Request,
  response: Response,
  next: NextFunction
) {
  if (request.method !== "GET" && request.method !== "HEAD") return next();
  if (request.path === "/health" || request.path === "/mcp") return next();
  try {
    const upstream = await fetch(`http://localhost:5173${request.originalUrl}`);
    response.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (["content-encoding", "content-length", "transfer-encoding"].includes(key)) return;
      response.setHeader(key, value);
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    response.send(body);
  } catch {
    response.status(502).send("Local Vite frontend is not reachable.");
  }
}

async function readWidgetAssets() {
  if (cachedWidgetAssets) return cachedWidgetAssets;
  const html = await readFile(widgetPath, "utf8");
  const script = extractInlineAsset(html, /<script type="module" crossorigin>([\s\S]*?)<\/script>/);
  const style = extractInlineAsset(html, /<style[^>]*>([\s\S]*?)<\/style>/);
  cachedWidgetAssets = {
    script,
    style,
    scriptGzip: gzipSync(script),
    styleGzip: gzipSync(style)
  };
  return cachedWidgetAssets;
}

function sendCompressedAsset(
  request: Request,
  response: Response,
  raw: string,
  gzipped: Buffer,
  contentType: string
) {
  response.setHeader("cache-control", "public, max-age=31536000, immutable");
  response.type(contentType);
  if (String(request.headers["accept-encoding"] ?? "").includes("gzip")) {
    response.setHeader("content-encoding", "gzip");
    response.send(gzipped);
    return;
  }
  response.send(raw);
}

function extractInlineAsset(html: string, pattern: RegExp): string {
  const match = pattern.exec(html);
  if (!match?.[1]) throw new Error("Built widget asset was not found. Run web build first.");
  return match[1];
}
