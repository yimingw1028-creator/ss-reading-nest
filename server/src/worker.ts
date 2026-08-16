import { createMcpHandler } from "agents/mcp";
import { READING_NEST_APP_VERSION } from "@ss/shared";
import { createReaderWidgetHtml } from "./mcp/reader-widget.js";
import { createMcpProbeResponse, normalizeMcpRequest } from "./mcp/request-compat.js";
import { createMcpServerFromRepository } from "./mcp/server-factory.js";
import { sanitizeBookshelfBundle } from "./privacy/sanitize-bookshelf.js";
import { D1ReadingRepository } from "./repositories/d1-reading-repository.js";
import { CloudSourceService } from "./services/cloud-source-service.js";
import { ReadingService } from "./services/reading-service.js";
import { handleSourceRoute } from "./source-routes.js";
import { createStandaloneReaderResponse } from "./standalone-reader.js";
import { R2SourceObjectStorage } from "./storage/r2-source-object-storage.js";
import { getWorkerRoute } from "./worker-router.js";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const route = getWorkerRoute(url, env.MCP_PATH_TOKEN);

    if (route === "health") {
      return Response.json({
        ok: true,
        app: "阿雾和陆沉的共读小巢",
        version: READING_NEST_APP_VERSION
      }, {
        headers: { "cache-control": "no-store" }
      });
    }
    if (route === "misconfigured") {
      console.error(JSON.stringify({ message: "MCP_PATH_TOKEN is not configured" }));
      return new Response("Service unavailable", { status: 503 });
    }
    if (route === "not-found") {
      return new Response("Not found", { status: 404 });
    }

    try {
      const repository = new D1ReadingRepository(env.DB);
      const sourceService = env.SOURCES_BUCKET
        ? new CloudSourceService(repository, new R2SourceObjectStorage(env.SOURCES_BUCKET))
        : undefined;
      if (route === "source") {
        const readingService = new ReadingService(repository);
        if (!sourceService && !url.pathname.endsWith("/bootstrap")) {
          return Response.json(
            { error: "Cloud source storage is not enabled for this deployment." },
            { status: 503 }
          );
        }
        return handleSourceRoute(request, sourceService, readingService);
      }
      const workerOrigin = url.origin;
      if (route === "reader") {
        const readingService = new ReadingService(repository);
        const snapshot = await readingService.getBookshelfSnapshot(false);
        const bookshelfSessions = snapshot.sessionBundles.map(sanitizeBookshelfBundle);
        const widgetHtml = createReaderWidgetHtml(url.origin);
        const standaloneState = {
          sourceEndpointBase: sourceService ? `${url.origin}/source/${env.MCP_PATH_TOKEN}` : undefined,
          bookshelfSessions,
          recentSessions: bookshelfSessions.slice(0, 10)
        };
        return createStandaloneReaderResponse(widgetHtml, standaloneState);
      }
      const server = createMcpServerFromRepository(
        repository,
        createReaderWidgetHtml(workerOrigin),
        sourceService,
        {
          ...(sourceService
            ? { sourceEndpointBase: `${url.origin}/source/${env.MCP_PATH_TOKEN}` }
            : {}),
          workerOrigin,
          lightweightSchemas: true
        }
      );
      const probeResponse = createMcpProbeResponse(request);
      if (probeResponse) return probeResponse;
      const mcpRequest = normalizeMcpRequest(request);
      return createMcpHandler(server, {
        route: url.pathname,
        enableJsonResponse: true
      })(mcpRequest, env, ctx);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "MCP request failed",
          error: error instanceof Error ? error.message : String(error),
          path: url.pathname
        })
      );
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal server error" } },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
