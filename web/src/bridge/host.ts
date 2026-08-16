import { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { READING_NEST_APP_VERSION } from "@ss/shared";
import type { ToolCallResult } from "../types/openai.js";

let app: McpApp | undefined;
let appReady: Promise<boolean> | undefined;
let latestToolOutput: Record<string, unknown> | undefined;
const toolOutputListeners = new Set<(output: Record<string, unknown>) => void>();

export type HostEnvironment =
  | "chatgpt-app-bridge"
  | "window-openai"
  | "no-host";

export interface UnavailableToolResult {
  unavailable: true;
  reason: HostEnvironment;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export const NO_HOST_MESSAGE = "请在 ChatGPT 内打开小书房后再使用陆沉陪读功能。";

export function detectHostEnvironment(): HostEnvironment {
  if (typeof window === "undefined") return "no-host";
  if (window.parent !== window) return "chatgpt-app-bridge";
  if (
    window.openai &&
    (typeof window.openai.callTool === "function" ||
      typeof window.openai.sendFollowUpMessage === "function")
  ) {
    return "window-openai";
  }
  return "no-host";
}

/**
 * Whether the current host can actually invoke MCP/server tools (callTool).
 * Independent from {@link canSendMessage}: a host may expose only one capability.
 */
export function canCallTool(): boolean {
  const env = detectHostEnvironment();
  if (env === "chatgpt-app-bridge") return true;
  if (env === "window-openai") return typeof window.openai?.callTool === "function";
  return false;
}

/**
 * Whether the current host can send a follow-up message to the assistant.
 * Independent from {@link canCallTool}.
 */
export function canSendMessage(): boolean {
  const env = detectHostEnvironment();
  if (env === "chatgpt-app-bridge") return true;
  if (env === "window-openai") {
    return typeof window.openai?.sendFollowUpMessage === "function";
  }
  return false;
}

export interface ReadingHostContext {
  displayMode?: "inline" | "pip" | "fullscreen";
  availableDisplayModes?: Array<"inline" | "pip" | "fullscreen">;
  containerDimensions?: {
    width?: number;
    maxWidth?: number;
    height?: number;
    maxHeight?: number;
  };
  safeAreaInsets?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

function connectApp() {
  if (typeof window === "undefined" || window.parent === window) return undefined;
  if (!app) {
    try {
      const nextApp = new McpApp({
        name: "阿雾和陆沉的共读小巢",
        version: READING_NEST_APP_VERSION
      });
      // This must be registered before connect(); the host can deliver the opening
      // tool result immediately after the initialization handshake.
      nextApp.ontoolresult = (result) => {
        const structuredContent = result.structuredContent;
        const privateBookshelf = result._meta?.privateBookshelf;
        if (
          (!structuredContent || typeof structuredContent !== "object") &&
          (!privateBookshelf || typeof privateBookshelf !== "object")
        ) {
          return;
        }
        latestToolOutput = mergeHostOutput(latestToolOutput, {
          ...(structuredContent && typeof structuredContent === "object" ? structuredContent : {}),
          ...(privateBookshelf && typeof privateBookshelf === "object" ? privateBookshelf : {})
        });
        for (const listener of toolOutputListeners) listener(latestToolOutput);
      };
      app = nextApp;
      // Defer connect() so a synchronous SDK/host exception can never abort the
      // module that mounts React. A later interaction may retry the bridge.
      appReady = Promise.resolve()
        .then(() => nextApp.connect())
        .then(() => app === nextApp)
        .catch(() => {
          if (app === nextApp) app = undefined;
          return false;
        });
    } catch {
      app = undefined;
      appReady = Promise.resolve(false);
      return undefined;
    }
  }
  return app;
}

async function isConnectedApp(bridge: McpApp): Promise<boolean> {
  const ready = appReady;
  return Boolean(ready && (await ready) && app === bridge);
}

export function initializeReadingHostBridge() {
  try {
    connectApp();
  } catch {
    // Rendering the reading room is more important than an optional host bridge.
  }
}

export function subscribeToolOutput<T extends Record<string, unknown>>(
  listener: (output: T) => void
): () => void {
  const existing = initialToolOutput<T>();
  if (existing) queueMicrotask(() => listener(existing));
  const wrapped = (output: Record<string, unknown>) => listener(output as T);
  const handleOpenAiGlobals = () => {
    const output = initialToolOutput<T>();
    if (output) listener(output);
  };
  toolOutputListeners.add(wrapped);
  window.addEventListener("openai:set_globals", handleOpenAiGlobals);
  return () => {
    toolOutputListeners.delete(wrapped);
    window.removeEventListener("openai:set_globals", handleOpenAiGlobals);
  };
}

export async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult | UnavailableToolResult> {
  let hostError: unknown;
  if (window.openai?.callTool) {
    try {
      const result = await window.openai.callTool(name, args);
      if (hasToolResultPayload(result)) return result;
      hostError = new Error("ChatGPT tool bridge returned an empty result");
    } catch (error) {
      hostError = error;
    }
  }

  const env = detectHostEnvironment();
  if (env === "chatgpt-app-bridge") {
    const bridge = connectApp();
    if (bridge && (await isConnectedApp(bridge))) {
      try {
        return (await bridge.callServerTool({ name, arguments: args })) as ToolCallResult;
      } catch (error) {
        hostError = error;
      }
    }
  }
  if (hostError) throw hostError;

  // No usable host bridge (pure browser / local dev without a mock): return an
  // explicit, typed result instead of a silent empty object so callers can tell
  // "not delivered" apart from "delivered with no content".
  return { unavailable: true, reason: env };
}

export async function askChatGpt(
  prompt: string,
  options: { scrollToBottom?: boolean } = {}
) {
  const env = detectHostEnvironment();
  let bridgeError: unknown;
  if (env === "chatgpt-app-bridge") {
    const bridge = connectApp();
    if (bridge && (await isConnectedApp(bridge))) {
      try {
        await bridge.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
        return;
      } catch (error) {
        bridgeError = error;
      }
    }
  }
  if (window.openai?.sendFollowUpMessage) {
    await window.openai.sendFollowUpMessage({
      prompt,
      scrollToBottom: options.scrollToBottom ?? false
    });
    return;
  }
  if (bridgeError) throw bridgeError;
}

export async function requestReaderPip(): Promise<boolean> {
  try {
    if (window.openai?.requestDisplayMode) {
      await window.openai.requestDisplayMode({ mode: "pip" });
      return true;
    }
    const bridge = connectApp();
    if (bridge && (await isConnectedApp(bridge))) {
      const result = await bridge.requestDisplayMode({ mode: "pip" });
      return result.mode === "pip";
    }
  } catch {
    return false;
  }
  return false;
}

export async function updateModelContext(context: Record<string, unknown>): Promise<boolean> {
  const bridge = connectApp();
  if (!bridge || !(await isConnectedApp(bridge))) return false;
  try {
    await bridge.updateModelContext({
      content: [{ type: "text", text: JSON.stringify(context) }]
    });
    return true;
  } catch {
    return false;
  }
}

export async function requestReaderFullscreen(): Promise<boolean> {
  try {
    if (window.openai?.requestDisplayMode) {
      await window.openai.requestDisplayMode({ mode: "fullscreen" });
      return true;
    }
    const bridge = connectApp();
    if (bridge && (await isConnectedApp(bridge))) {
      const result = await bridge.requestDisplayMode({ mode: "fullscreen" });
      return result.mode === "fullscreen";
    }
  } catch {
    return false;
  }
  return false;
}

export async function requestReaderInline(): Promise<boolean> {
  try {
    if (window.openai?.requestDisplayMode) {
      await window.openai.requestDisplayMode({ mode: "inline" });
      return true;
    }
    const bridge = connectApp();
    if (bridge && (await isConnectedApp(bridge))) {
      const result = await bridge.requestDisplayMode({ mode: "inline" });
      return result.mode === "inline";
    }
  } catch {
    return false;
  }
  return false;
}

export function saveReaderWidgetState(state: ReaderWidgetState) {
  window.openai?.setWidgetState?.(state);
}

export function initialWidgetState(): ReaderWidgetState | undefined {
  return window.openai?.widgetState;
}

export function initialToolOutput<T>(): T | undefined {
  const bootstrap =
    window.__SS_READING_NEST_BOOTSTRAP__ &&
    typeof window.__SS_READING_NEST_BOOTSTRAP__ === "object"
      ? window.__SS_READING_NEST_BOOTSTRAP__
      : undefined;
  const privateBookshelf = findPrivateBookshelf(window.openai?.toolResponseMetadata);
  const directToolOutput =
    window.openai?.toolOutput && typeof window.openai.toolOutput === "object"
      ? (window.openai.toolOutput as Record<string, unknown>)
      : undefined;
  const merged = [
    bootstrap,
    directToolOutput,
    privateBookshelf && typeof privateBookshelf === "object"
      ? (privateBookshelf as Record<string, unknown>)
      : undefined,
    latestToolOutput
  ].reduce<Record<string, unknown>>(
    (current, output) => mergeHostOutput(current, output, true),
    {}
  );
  return Object.keys(merged).length > 0 ? (merged as T) : undefined;
}

function mergeHostOutput(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
  preserveNonEmptyArrays = false
): Record<string, unknown> {
  if (!incoming) return { ...(current ?? {}) };
  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "sourceEndpointBase") {
      if (typeof value === "string" && value.length > 0) merged[key] = value;
      continue;
    }
    if (value !== undefined) merged[key] = value;
  }
  if (preserveNonEmptyArrays) {
    for (const key of ["bookshelfSessions", "recentSessions", "readingRecords"] as const) {
      const previous = current?.[key];
      const next = incoming[key];
      if (
        Array.isArray(previous) &&
        previous.length > 0 &&
        Array.isArray(next) &&
        next.length === 0
      ) {
        merged[key] = previous;
      }
    }
  }
  return merged;
}

function hasToolResultPayload(result: ToolCallResult | undefined): result is ToolCallResult {
  if (!result || typeof result !== "object") return false;
  return (
    "structuredContent" in result ||
    "content" in result ||
    "_meta" in result ||
    "isError" in result
  );
}

function findPrivateBookshelf(
  value: unknown,
  depth = 0,
  visited = new Set<object>()
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || depth > 5 || visited.has(value)) return undefined;
  visited.add(value);

  const record = value as Record<string, unknown>;
  if (record.privateBookshelf && typeof record.privateBookshelf === "object") {
    return record.privateBookshelf as Record<string, unknown>;
  }

  for (const key of ["_meta", "mcp_tool_result", "call_tool_result", "result", "metadata"]) {
    const found = findPrivateBookshelf(record[key], depth + 1, visited);
    if (found) return found;
  }
  return undefined;
}

export function subscribeHostContext(
  listener: (context: ReadingHostContext) => void
): () => void {
  const legacyListener = (event: Event) => {
    listener((event as CustomEvent<ReadingHostContext>).detail ?? {});
  };
  window.addEventListener("openai:host-context-changed", legacyListener);

  const bridge = connectApp();
  const bridgeListener = (context: ReadingHostContext) => listener(context);
  if (bridge) {
    bridge.addEventListener("hostcontextchanged", bridgeListener);
    void isConnectedApp(bridge).then((ready) => {
      if (ready) listener((bridge.getHostContext() ?? {}) as ReadingHostContext);
    });
  } else if (window.openai?.hostContext) {
    listener(window.openai.hostContext);
  }

  return () => {
    window.removeEventListener("openai:host-context-changed", legacyListener);
    bridge?.removeEventListener("hostcontextchanged", bridgeListener);
  };
}
