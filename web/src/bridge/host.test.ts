import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = {
  connect: vi.fn().mockResolvedValue(undefined),
  callServerTool: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  updateModelContext: vi.fn().mockResolvedValue({}),
  requestDisplayMode: vi.fn().mockResolvedValue({ mode: "fullscreen" })
};

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    connect = bridge.connect;
    callServerTool = bridge.callServerTool;
    sendMessage = bridge.sendMessage;
    updateModelContext = bridge.updateModelContext;
    requestDisplayMode = bridge.requestDisplayMode;
  }
}));

type Win = Window & {
  openai?: {
    callTool?: (...args: unknown[]) => unknown;
    sendFollowUpMessage?: (...args: unknown[]) => unknown;
    [key: string]: unknown;
  };
  __SS_HOST_MOCK__?: boolean;
};

describe("host bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete window.__SS_READING_NEST_BOOTSTRAP__;
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: {}
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        setWidgetState: vi.fn(),
        widgetState: {
          screen: "novel",
          sessionId: "session-1",
          positionIndex: 2,
          scrollTop: 120
        }
      }
    });
  });

  it("updates model-visible context through the MCP Apps bridge", async () => {
    const { updateModelContext } = await import("./host.js");

    await expect(updateModelContext({ title: "Book", currentText: "paragraph" })).resolves.toBe(true);
    expect(bridge.updateModelContext).toHaveBeenCalledWith({
      content: [
        {
          type: "text",
          text: expect.stringContaining('"currentText":"paragraph"')
        }
      ]
    });
  });

  it("never lets a synchronous host connection failure abort app startup", async () => {
    bridge.connect.mockImplementationOnce(() => {
      throw new Error("host SDK failed during connect");
    });
    const { initializeReadingHostBridge } = await import("./host.js");

    expect(() => initializeReadingHostBridge()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("does not call a bridge instance whose initialization handshake failed", async () => {
    bridge.connect.mockRejectedValueOnce(new Error("host handshake unavailable"));
    const { callTool: invokeTool } = await import("./host.js");

    await expect(invokeTool("get_novel_bookshelf", {})).resolves.toMatchObject({
      unavailable: true,
      reason: "chatgpt-app-bridge"
    });
    expect(bridge.callServerTool).not.toHaveBeenCalled();
  });

  it("falls back to the standard MCP bridge when ChatGPT's native follow-up bridge is unavailable", async () => {
    const { askChatGpt, requestReaderFullscreen } = await import("./host.js");

    await expect(requestReaderFullscreen()).resolves.toBe(true);
    await askChatGpt("陪我看看这里", { scrollToBottom: false });

    expect(bridge.requestDisplayMode).toHaveBeenCalledWith({ mode: "fullscreen" });
    expect(bridge.sendMessage).toHaveBeenCalledWith({
      role: "user",
      content: [{ type: "text", text: "陪我看看这里" }]
    });
  });

  it("uses ChatGPT's native tool bridge inside the component iframe when it is available", async () => {
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: { bookshelfSessions: [{ session: { id: "book-1" } }] }
    });
    if (window.openai) window.openai.callTool = callTool;
    const { callTool: invokeTool } = await import("./host.js");

    const result = await invokeTool("get_novel_bookshelf", {});

    expect(callTool).toHaveBeenCalledWith("get_novel_bookshelf", {});
    expect(bridge.callServerTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      structuredContent: { bookshelfSessions: [{ session: { id: "book-1" } }] }
    });
  });

  it("falls back to the MCP Apps tool bridge when the native tool bridge fails", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("native bridge unavailable"));
    if (window.openai) window.openai.callTool = callTool;
    bridge.callServerTool.mockResolvedValueOnce({
      structuredContent: { bookshelfSessions: [{ session: { id: "book-2" } }] }
    });
    const { callTool: invokeTool } = await import("./host.js");

    const result = await invokeTool("get_novel_bookshelf", {});

    expect(callTool).toHaveBeenCalledWith("get_novel_bookshelf", {});
    expect(bridge.callServerTool).toHaveBeenCalledWith({
      name: "get_novel_bookshelf",
      arguments: {}
    });
    expect(result).toMatchObject({
      structuredContent: { bookshelfSessions: [{ session: { id: "book-2" } }] }
    });
  });

  it("prefers the MCP Apps bridge inside the ChatGPT component iframe", async () => {
    const sendFollowUpMessage = vi.fn().mockResolvedValue(undefined);
    if (window.openai) window.openai.sendFollowUpMessage = sendFollowUpMessage;
    const { askChatGpt } = await import("./host.js");

    await askChatGpt("陪我看看这里", { scrollToBottom: false });

    expect(bridge.sendMessage).toHaveBeenCalledWith({
      role: "user",
      content: [{ type: "text", text: "陪我看看这里" }]
    });
    expect(sendFollowUpMessage).not.toHaveBeenCalled();
  });

  it("falls back to the native follow-up bridge when MCP Apps send fails", async () => {
    bridge.sendMessage.mockRejectedValueOnce(new Error("MCP Apps send unavailable"));
    const sendFollowUpMessage = vi.fn().mockResolvedValue(undefined);
    if (window.openai) window.openai.sendFollowUpMessage = sendFollowUpMessage;
    const { askChatGpt } = await import("./host.js");

    await askChatGpt("陪我看看这里", { scrollToBottom: false });

    expect(sendFollowUpMessage).toHaveBeenCalledWith({
      prompt: "陪我看看这里",
      scrollToBottom: false
    });
  });

  it("uses ChatGPT's native follow-up bridge in a top-level window-openai host", async () => {
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: window
    });
    const sendFollowUpMessage = vi.fn().mockResolvedValue(undefined);
    if (window.openai) window.openai.sendFollowUpMessage = sendFollowUpMessage;
    const { askChatGpt } = await import("./host.js");

    await askChatGpt("陪我看看这里", { scrollToBottom: false });

    expect(sendFollowUpMessage).toHaveBeenCalledWith({
      prompt: "陪我看看这里",
      scrollToBottom: false
    });
    expect(bridge.requestDisplayMode).not.toHaveBeenCalled();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it("starts the direct ChatGPT fullscreen request in the user gesture call stack", async () => {
    const requestDisplayMode = vi.fn().mockResolvedValue(undefined);
    if (window.openai) window.openai.requestDisplayMode = requestDisplayMode;
    const { requestReaderFullscreen } = await import("./host.js");

    const result = requestReaderFullscreen();

    expect(requestDisplayMode).toHaveBeenCalledWith({ mode: "fullscreen" });
    expect(bridge.requestDisplayMode).not.toHaveBeenCalled();
    await expect(result).resolves.toBe(true);
  });

  it("starts the direct ChatGPT floating reader request in the user gesture call stack", async () => {
    const requestDisplayMode = vi.fn().mockResolvedValue(undefined);
    if (window.openai) window.openai.requestDisplayMode = requestDisplayMode;
    const { requestReaderPip } = await import("./host.js");

    const result = requestReaderPip();

    expect(requestDisplayMode).toHaveBeenCalledWith({ mode: "pip" });
    expect(bridge.requestDisplayMode).not.toHaveBeenCalled();
    await expect(result).resolves.toBe(true);
  });

  it("stores and restores only lightweight reader widget state", async () => {
    const { initialWidgetState, saveReaderWidgetState } = await import("./host.js");
    const state = {
      screen: "novel" as const,
      sessionId: "session-1",
      positionIndex: 3,
      scrollTop: 240
    };

    saveReaderWidgetState(state);

    expect(window.openai?.setWidgetState).toHaveBeenCalledWith(state);
    expect(initialWidgetState()).toEqual({
      screen: "novel",
      sessionId: "session-1",
      positionIndex: 2,
      scrollTop: 120
    });
  });

  it("merges legacy tool output with private bookshelf response metadata", async () => {
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { count: 1 },
        toolResponseMetadata: {
          privateBookshelf: {
            bookshelfSessions: [{ session: { id: "private-book" } }],
            sourceEndpointBase: "/source/redacted"
          }
        }
      }
    });
    const { initialToolOutput } = await import("./host.js");

    expect(initialToolOutput()).toEqual({
      count: 1,
      bookshelfSessions: [{ session: { id: "private-book" } }],
      sourceEndpointBase: "/source/redacted"
    });
  });

  it("uses the protected resource bootstrap and lets live host output override it", async () => {
    window.__SS_READING_NEST_BOOTSTRAP__ = {
      bookshelfSessions: [{ session: { id: "bootstrap-book" } }],
      sourceEndpointBase: "/source/bootstrap"
    };
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: {
          bookshelfSessions: [{ session: { id: "live-book" } }]
        }
      }
    });
    const { initialToolOutput } = await import("./host.js");

    expect(initialToolOutput()).toEqual({
      bookshelfSessions: [{ session: { id: "live-book" } }],
      sourceEndpointBase: "/source/bootstrap"
    });
  });

  it("does not let a null source endpoint erase a previously valid endpoint", async () => {
    window.__SS_READING_NEST_BOOTSTRAP__ = {
      sourceEndpointBase: "/source/bootstrap"
    };
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { sourceEndpointBase: null }
      }
    });
    const { initialToolOutput } = await import("./host.js");

    expect(initialToolOutput()).toEqual({
      sourceEndpointBase: "/source/bootstrap"
    });
  });

  it("does not let empty delayed globals erase protected bookshelf data", async () => {
    window.__SS_READING_NEST_BOOTSTRAP__ = {
      bookshelfSessions: [{ session: { id: "protected-book" } }],
      recentSessions: [{ session: { id: "protected-book" } }],
      readingRecords: [{ id: "protected-record" }],
      sourceEndpointBase: "/source/bootstrap"
    };
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: {
          count: 0,
          bookshelfSessions: [],
          recentSessions: [],
          readingRecords: []
        }
      }
    });
    const { initialToolOutput } = await import("./host.js");

    expect(initialToolOutput()).toEqual({
      count: 0,
      bookshelfSessions: [{ session: { id: "protected-book" } }],
      recentSessions: [{ session: { id: "protected-book" } }],
      readingRecords: [{ id: "protected-record" }],
      sourceEndpointBase: "/source/bootstrap"
    });
  });

  it("reads private bookshelf data from ChatGPT's canonical MCP result metadata", async () => {
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { count: 1 },
        toolResponseMetadata: {
          status: "complete",
          mcp_tool_result: {
            structuredContent: { count: 1 },
            _meta: {
              privateBookshelf: {
                bookshelfSessions: [{ session: { id: "canonical-book" } }],
                sourceEndpointBase: "/source/redacted"
              }
            }
          }
        }
      }
    });
    const { initialToolOutput } = await import("./host.js");

    expect(initialToolOutput()).toEqual({
      count: 1,
      bookshelfSessions: [{ session: { id: "canonical-book" } }],
      sourceEndpointBase: "/source/redacted"
    });
  });

  it("refreshes tool output when ChatGPT publishes delayed globals", async () => {
    const { subscribeToolOutput } = await import("./host.js");
    const listener = vi.fn();
    const unsubscribe = subscribeToolOutput(listener);
    Object.defineProperty(window, "openai", {
      configurable: true,
      value: {
        toolOutput: { count: 1 },
        toolResponseMetadata: {
          call_tool_result: {
            result: {
              _meta: {
                privateBookshelf: {
                  bookshelfSessions: [{ session: { id: "delayed-book" } }]
                }
              }
            }
          }
        }
      }
    });

    window.dispatchEvent(new Event("openai:set_globals"));

    expect(listener).toHaveBeenCalledWith({
      count: 1,
      bookshelfSessions: [{ session: { id: "delayed-book" } }]
    });
    unsubscribe();
  });
});

describe("Host capability model (Phase 3A.1)", () => {
  type Snapshot = {
    parent: Window["parent"];
    openai: Win["openai"];
    mock: Win["__SS_HOST_MOCK__"];
  };
  let saved: Snapshot | null = null;

  beforeEach(() => {
    vi.resetModules();
    saved = {
      parent: window.parent,
      openai: (window as Win).openai,
      mock: (window as Win).__SS_HOST_MOCK__
    };
  });

  afterEach(() => {
    if (!saved) return;
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: saved.parent
    });
    Object.defineProperty(window, "openai", {
      configurable: true,
      writable: true,
      value: saved.openai
    });
    if (saved.mock === undefined) {
      delete (window as Win).__SS_HOST_MOCK__;
    } else {
      Object.defineProperty(window, "__SS_HOST_MOCK__", {
        configurable: true,
        writable: true,
        value: saved.mock
      });
    }
  });

  function setWindow(opts: {
    iframe?: boolean;
    callTool?: boolean;
    sendFollowUpMessage?: boolean;
    mock?: boolean;
  }) {
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: opts.iframe ? ({} as Window) : window
    });
    delete (window as Win).__SS_HOST_MOCK__;
    const openai: Record<string, unknown> = {};
    if (opts.callTool) openai.callTool = async () => ({});
    if (opts.sendFollowUpMessage) openai.sendFollowUpMessage = async () => undefined;
    Object.defineProperty(window, "openai", {
      configurable: true,
      writable: true,
      value: Object.keys(openai).length ? openai : undefined
    });
    if (opts.mock) {
      Object.defineProperty(window, "__SS_HOST_MOCK__", {
        configurable: true,
        writable: true,
        value: true
      });
    }
  }

  it("detects a pure browser with no host (matrix E)", async () => {
    setWindow({});
    const { detectHostEnvironment, canCallTool, canSendMessage } = await import("./host.js");
    expect(detectHostEnvironment()).toBe("no-host");
    expect(canCallTool()).toBe(false);
    expect(canSendMessage()).toBe(false);
  });

  it("detects the ChatGPT App bridge iframe (matrix A)", async () => {
    setWindow({ iframe: true });
    const { detectHostEnvironment, canCallTool, canSendMessage } = await import("./host.js");
    expect(detectHostEnvironment()).toBe("chatgpt-app-bridge");
    expect(canCallTool()).toBe(true);
    expect(canSendMessage()).toBe(true);
  });

  it("detects window.openai with only callTool (matrix B)", async () => {
    setWindow({ callTool: true });
    const { detectHostEnvironment, canCallTool, canSendMessage } = await import("./host.js");
    expect(detectHostEnvironment()).toBe("window-openai");
    expect(canCallTool()).toBe(true);
    expect(canSendMessage()).toBe(false);
  });

  it("detects window.openai with only sendFollowUpMessage (matrix C)", async () => {
    setWindow({ sendFollowUpMessage: true });
    const { detectHostEnvironment, canCallTool, canSendMessage } = await import("./host.js");
    expect(detectHostEnvironment()).toBe("window-openai");
    expect(canCallTool()).toBe(false);
    expect(canSendMessage()).toBe(true);
  });

  it("detects window.openai with both capabilities (matrix D)", async () => {
    setWindow({ callTool: true, sendFollowUpMessage: true });
    const { detectHostEnvironment, canCallTool, canSendMessage } = await import("./host.js");
    expect(detectHostEnvironment()).toBe("window-openai");
    expect(canCallTool()).toBe(true);
    expect(canSendMessage()).toBe(true);
  });

  it("no longer treats __SS_HOST_MOCK__ as a host environment", async () => {
    setWindow({ mock: true });
    const { detectHostEnvironment, canCallTool, canSendMessage } = await import("./host.js");
    expect(detectHostEnvironment()).toBe("no-host");
    expect(canCallTool()).toBe(false);
    expect(canSendMessage()).toBe(false);
  });

  it("callTool returns a typed unavailable result (no structuredContent) when no host", async () => {
    setWindow({});
    const { callTool } = await import("./host.js");
    const result = await callTool("send_current_context", { foo: 1 });
    expect(result).toMatchObject({ unavailable: true, reason: "no-host" });
    expect("structuredContent" in result).toBe(false);
    expect("_meta" in result).toBe(false);
  });

  it("callTool returns unavailable with the window-openai reason when only sendFollowUpMessage exists", async () => {
    setWindow({ sendFollowUpMessage: true });
    const { callTool } = await import("./host.js");
    const result = await callTool("send_current_context", {});
    expect(result).toMatchObject({ unavailable: true, reason: "window-openai" });
  });

  it("exposes the required no-host message", async () => {
    const { NO_HOST_MESSAGE } = await import("./host.js");
    expect(NO_HOST_MESSAGE).toBe("请在 ChatGPT 内打开小书房后再使用陆沉陪读功能。");
  });
});
