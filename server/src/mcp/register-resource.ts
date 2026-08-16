import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createReadingNestCompatibilityProbeHtml } from "./compatibility-probe.js";
import {
  READING_NEST_COMPATIBILITY_LEGACY_URIS,
  READING_NEST_COMPATIBILITY_URI,
  READING_NEST_LEGACY_URIS,
  READING_NEST_URI
} from "./register-tools.js";

const READING_NEST_DESCRIPTION =
  "一个温暖的移动端共读小窝，用于阅读用户自己粘贴或导入的小说文本。";

type ReadingResourceBootstrap = Record<string, unknown>;
type ReadingResourceBootstrapLoader = () => Promise<ReadingResourceBootstrap>;

function serializeBootstrap(value: ReadingResourceBootstrap) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function injectBootstrap(widgetHtml: string, bootstrap: ReadingResourceBootstrap) {
  const script =
    `<script>window.__SS_READING_NEST_BOOTSTRAP__=${serializeBootstrap(bootstrap)};</script>`;
  return widgetHtml.includes("</head>")
    ? widgetHtml.replace("</head>", `${script}</head>`)
    : `${script}${widgetHtml}`;
}

function createWidgetMetadata(workerOrigin?: string) {
  const allowedOrigin = workerOrigin ?? "http://localhost:8787";
  const resourceCsp = {
    connectDomains: [allowedOrigin],
    resourceDomains: [allowedOrigin]
  };
  const openaiWidgetCsp = {
    connect_domains: [allowedOrigin],
    resource_domains: [allowedOrigin]
  };
  return { resourceCsp, openaiWidgetCsp };
}

function createResourceMeta(
  resourceCsp: { connectDomains: string[]; resourceDomains: string[] },
  openaiWidgetCsp: { connect_domains: string[]; resource_domains: string[] },
  description: string
) {
  return {
    ui: {
      prefersBorder: true,
      csp: resourceCsp
    },
    "openai/widgetCSP": openaiWidgetCsp,
    "openai/widgetDescription": description,
    "openai/widgetPrefersBorder": true
  };
}

export function registerReadingResource(
  server: McpServer,
  widgetHtml: string,
  workerOrigin?: string,
  loadBootstrap?: ReadingResourceBootstrapLoader
) {
  const { resourceCsp, openaiWidgetCsp } = createWidgetMetadata(workerOrigin);
  const resourceMeta = createResourceMeta(
    resourceCsp,
    openaiWidgetCsp,
    READING_NEST_DESCRIPTION
  );

  for (const uri of [READING_NEST_URI, ...READING_NEST_LEGACY_URIS]) {
    registerAppResource(
      server,
      "阿雾和陆沉的共读小巢",
      uri,
      {
        description: "移动端优先的小说共读小窝",
        _meta: resourceMeta
      },
      async () => {
        let resourceHtml = widgetHtml;
        if (loadBootstrap) {
          try {
            resourceHtml = injectBootstrap(widgetHtml, await loadBootstrap());
          } catch (error) {
            console.error(
              JSON.stringify({
                message: "Reading resource bootstrap failed",
                error: error instanceof Error ? error.message : String(error)
              })
            );
          }
        }
        return {
          contents: [
            {
              uri,
              mimeType: RESOURCE_MIME_TYPE,
              text: resourceHtml,
              _meta: resourceMeta
            }
          ]
        };
      }
    );
  }
}

export function registerReadingCompatibilityProbeResource(server: McpServer, workerOrigin?: string) {
  const { resourceCsp, openaiWidgetCsp } = createWidgetMetadata(workerOrigin);
  const resourceMeta = createResourceMeta(
    resourceCsp,
    openaiWidgetCsp,
    "一个最小的 ChatGPT App 组件，用于确认原生客户端能否渲染阿雾和陆沉的共读小巢。"
  );

  for (const uri of [
    READING_NEST_COMPATIBILITY_URI,
    ...READING_NEST_COMPATIBILITY_LEGACY_URIS
  ]) {
    registerAppResource(
      server,
      "阿雾和陆沉的共读小巢 App 兼容性检查",
      uri,
      {
        description: "一个最小的 ChatGPT App 组件，用于确认原生客户端能否渲染阿雾和陆沉的共读小巢。",
        _meta: resourceMeta
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPE,
            text: createReadingNestCompatibilityProbeHtml(),
            _meta: resourceMeta
          }
        ]
      })
    );
  }
}
