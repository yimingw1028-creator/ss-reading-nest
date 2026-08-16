import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_PREFERENCES } from "@ss/shared";
import type { Quote, Reaction } from "@ss/shared";
import { NovelReader } from "./NovelReader.js";

function makeProps() {
  return {
    session: {
      id: "novel-session",
      title: "小说",
      type: "novel" as const,
      status: "active" as const,
      userCurrentPosition: {
        kind: "paragraph" as const,
        index: 1,
        total: 2,
        label: "第 1 段"
      },
      assistantSyncedPosition: null,
      liveReadingEnabled: false,
      sessionPreferences: DEFAULT_SESSION_PREFERENCES,
      sourceManifest: null,
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
      lastReadAt: "2026-06-22T00:00:00.000Z"
    },
    chunks: ["第一句话。第二句话。", "下一页。"],
    savedQuotes: [] as Quote[],
    savedReactions: [] as Reaction[],
    onPosition: vi.fn(),
    onSharePage: vi.fn(),
    onAskSelection: vi.fn(),
    onSaveThought: vi.fn(),
    onSaveClearThought: vi.fn(),
    onFinish: vi.fn(),
    onBack: vi.fn(),
    onFullscreen: vi.fn(),
    layoutRevision: 0,
    actionInFlight: false,
    canRequestPip: false,
    onRequestPip: vi.fn(),
    initialScrollTop: 0,
    onScrollPosition: vi.fn()
  };
}

function selectText(text: string, anchorNode: Node) {
  vi.spyOn(window, "getSelection").mockReturnValue({
    toString: () => text,
    anchorNode,
    removeAllRanges: vi.fn()
  } as unknown as Selection);
}

describe("NovelReader", () => {
  it("keeps the page number in the bottom action bar without a more-actions entry", () => {
    render(<NovelReader {...makeProps()} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "阅读进度 1 / 2，打开目录与跳页"
      })
    );
    expect(screen.getByRole("dialog", { name: "目录和跳页" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();
  });

  it("restores the reading scroll position after layout changes", () => {
    const props = { ...makeProps(), initialScrollTop: 96 };
    const { container, rerender } = render(<NovelReader {...props} />);
    const scroll = container.querySelector<HTMLElement>(".reader-scroll")!;
    expect(scroll.scrollTop).toBe(96);
    scroll.scrollTop = 0;

    rerender(<NovelReader {...props} layoutRevision={1} />);
    expect(scroll.scrollTop).toBe(96);
  });

  it("opens the lightweight navigation drawer and jumps to a valid page", () => {
    const props = {
      ...makeProps(),
      chunks: ["序言。", "第一章 重逢\n章节内容。", "第二章 回信\n章节内容。"]
    };
    render(<NovelReader {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "目录" }));
    expect(screen.getByRole("dialog", { name: "目录和跳页" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("跳到页码"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "前往" }));

    expect(props.onPosition).toHaveBeenCalledWith(3);
    expect(screen.queryByRole("dialog", { name: "目录和跳页" })).not.toBeInTheDocument();
  });

  it("validates page jump input without changing position", () => {
    const props = {
      ...makeProps(),
      chunks: ["第一页。", "第二页。", "第三页。"]
    };
    render(<NovelReader {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "目录" }));
    fireEvent.change(screen.getByLabelText("跳到页码"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "前往" }));

    expect(screen.getByRole("alert")).toHaveTextContent("页码范围是 1 到 3。");
    expect(props.onPosition).not.toHaveBeenCalled();
  });

  it("lists recognized chapter headings and falls back when none are found", () => {
    const props = {
      ...makeProps(),
      chunks: ["开头。", "## 第一章 雨夜\n故事开始。", "第 2 节\n下一段。"]
    };
    const { rerender } = render(<NovelReader {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "目录" }));
    expect(screen.getByRole("button", { name: "第一章 雨夜，第 2 页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "第 2 节，第 3 页" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "第一章 雨夜，第 2 页" }));
    expect(props.onPosition).toHaveBeenCalledWith(2);

    rerender(<NovelReader {...props} chunks={["没有标题。", "只是正文。"]} />);
    fireEvent.click(screen.getByRole("button", { name: "目录" }));
    expect(screen.getByText("暂未识别到章节目录")).toBeInTheDocument();
  });

  it("saves a thought without sending the whole page", async () => {
    const props = makeProps();
    const { container } = render(<NovelReader {...props} />);
    const textNode = screen.getByText("第一句话。第二句话。").firstChild!;
    selectText("第二句话。", textNode);

    fireEvent.mouseUp(container.querySelector(".novel-paper")!);
    fireEvent.click(screen.getByRole("button", { name: "写想法" }));
    fireEvent.change(screen.getByRole("textbox", { name: "我的划线想法" }), {
      target: { value: "我觉得这一句很有力量。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "存入本页想法" }));

    await waitFor(() => {
      expect(props.onSaveThought).toHaveBeenCalledWith(
        "第二句话。",
        "我觉得这一句很有力量。"
      );
    });
    expect(props.onSharePage).not.toHaveBeenCalled();
    expect(props.onAskSelection).not.toHaveBeenCalled();
  });

  it("asks about only the selected sentence", async () => {
    const props = makeProps();
    const { container } = render(<NovelReader {...props} />);
    const textNode = screen.getByText("第一句话。第二句话。").firstChild!;
    selectText("第一句话。", textNode);

    fireEvent.mouseUp(container.querySelector(".novel-paper")!);
    fireEvent.click(screen.getByRole("button", { name: "直接提问" }));
    fireEvent.change(screen.getByRole("textbox", { name: "针对划线的问题" }), {
      target: { value: "为什么这么说？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "立即问陆沉" }));

    await waitFor(() => {
      expect(props.onAskSelection).toHaveBeenCalledWith("第一句话。", "为什么这么说？");
    });
    expect(props.onSharePage).not.toHaveBeenCalled();
  });

  it("shows saved highlights and lets the thought be edited", () => {
    const props = makeProps();
    props.savedQuotes = [
      {
        id: "quote-1",
        sessionId: "novel-session",
        content: "第二句话。",
        note: "旧想法",
        clearThought: "已经想清楚的一点",
        position: { kind: "paragraph", index: 1, label: "第 1 段" },
        createdAt: "2026-06-22T00:00:00.000Z"
      }
    ];
    render(<NovelReader {...props} />);

    expect(screen.getByText("第二句话。", { selector: "mark" })).toBeInTheDocument();
    const summary = screen.getByRole("button", { name: /本页共读记录/ });
    expect(summary).toHaveAttribute("aria-label", "打开本页共读记录：1 条，清思 1 条");
    expect(screen.queryByRole("dialog", { name: "本页想法" })).not.toBeInTheDocument();
    fireEvent.click(summary);
    expect(screen.getByRole("dialog", { name: "本页想法" })).toBeInTheDocument();
    expect(screen.getByText("已经想清楚的一点")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开这句" }));
    expect(screen.getByRole("dialog", { name: "划线清思" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/粘贴陆沉说得好的地方/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑清思" }));
    expect(screen.getByPlaceholderText(/粘贴陆沉说得好的地方/)).toHaveValue("已经想清楚的一点");
    fireEvent.click(screen.getByRole("button", { name: "修改意绪" }));
    expect(screen.getByRole("textbox", { name: "我的划线想法" })).toHaveValue("旧想法");
  });

  it("shows assistant replies beside the page and the anchored quote", () => {
    const props = makeProps();
    props.savedQuotes = [{
      id: "quote-discussion",
      sessionId: "novel-session",
      content: "第二句话。",
      note: "我觉得这里是在告别。",
      position: { kind: "paragraph", index: 1, label: "第 1 段" },
      createdAt: "2026-06-22T00:00:00.000Z"
    }];
    props.savedReactions = [{
      id: "assistant-reply",
      sessionId: "novel-session",
      content: "我先保留一点，它也可能只是暂时收起。",
      position: { kind: "paragraph", index: 1, label: "第 1 段" },
      speaker: "assistant",
      quoteId: "quote-discussion",
      createdAt: "2026-06-22T00:01:00.000Z"
    }];

    render(<NovelReader {...props} />);

    const summary = screen.getByRole("button", { name: /本页共读记录/ });
    expect(summary).toHaveAttribute("aria-label", "打开本页共读记录：2 条，1 条回声");
    fireEvent.click(summary);
    expect(screen.getByText("我先保留一点，它也可能只是暂时收起。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开这句" }));
    expect(screen.getByText("共读回声")).toBeInTheDocument();
    expect(screen.getByText("我先保留一点，它也可能只是暂时收起。")).toBeInTheDocument();
  });

  it("does not highlight every occurrence of a one-character accidental quote", () => {
    const props = makeProps();
    props.savedQuotes = [{
      id: "quote-one-character",
      sessionId: "novel-session",
      content: "第",
      note: "误触保存",
      position: { kind: "paragraph", index: 1, label: "第 1 页" },
      createdAt: "2026-06-22T00:00:00.000Z"
    }];

    render(<NovelReader {...props} />);

    expect(document.querySelectorAll("mark.quote-highlight")).toHaveLength(0);
  });

  it("lets a saved clear thought be deleted explicitly", async () => {
    const props = makeProps();
    props.savedQuotes = [{
      id: "quote-with-clear-thought",
      sessionId: "novel-session",
      content: "第二句话。",
      note: "最初的意绪",
      clearThought: "这条清思可以单独删除",
      position: { kind: "paragraph", index: 1, label: "第 1 页" },
      createdAt: "2026-06-22T00:00:00.000Z"
    }];

    render(<NovelReader {...props} />);

    fireEvent.click(screen.getByText("第二句话。", { selector: "mark" }));
    fireEvent.click(screen.getByRole("button", { name: "删除清思" }));

    await waitFor(() => {
      expect(props.onSaveClearThought).toHaveBeenCalledWith(
        "quote-with-clear-thought",
        ""
      );
    });
  });

  it("opens a highlighted thought and saves clear thinking", async () => {
    const props = makeProps();
    props.savedQuotes = [
      {
        id: "quote-clear",
        sessionId: "novel-session",
        content: "第二句话。",
        note: "最初的意绪",
        position: { kind: "paragraph", index: 1, label: "第 1 段" },
        createdAt: "2026-06-22T00:00:00.000Z"
      }
    ];
    render(<NovelReader {...props} />);

    fireEvent.click(screen.getByText("第二句话。", { selector: "mark" }));
    expect(screen.getByRole("dialog", { name: "划线清思" })).toBeInTheDocument();
    expect(screen.getByText("最初的意绪")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/粘贴陆沉说得好的地方/), {
      target: { value: "聊完之后，我发现这里真正说的是持续反馈。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存清思" }));

    await waitFor(() => {
      expect(props.onSaveClearThought).toHaveBeenCalledWith(
        "quote-clear",
        "聊完之后，我发现这里真正说的是持续反馈。"
      );
    });
  });

  it("refreshes the current page thought summary after saving clear thinking", async () => {
    function ControlledReader() {
      const [savedQuotes, setSavedQuotes] = useState<Quote[]>([
        {
          id: "quote-refresh",
          sessionId: "novel-session",
          content: "第二句话。",
          note: "最初的意绪",
          position: { kind: "paragraph", index: 1, label: "第 1 段" },
          createdAt: "2026-06-22T00:00:00.000Z"
        }
      ]);
      const props = makeProps();

      return (
        <NovelReader
          {...props}
          savedQuotes={savedQuotes}
          onSaveClearThought={async (quoteId, clearThought) => {
            const saved = savedQuotes.map((quote) =>
              quote.id === quoteId
                ? { ...quote, clearThought: clearThought || undefined }
                : quote
            );
            setSavedQuotes(saved);
            return saved.find((quote) => quote.id === quoteId);
          }}
        />
      );
    }

    render(<ControlledReader />);

    const summary = screen.getByRole("button", { name: /本页共读记录/ });
    expect(summary).toHaveAttribute("aria-label", "打开本页共读记录：1 条");
    fireEvent.click(screen.getByText("第二句话。", { selector: "mark" }));
    fireEvent.change(screen.getByPlaceholderText(/粘贴陆沉说得好的地方/), {
      target: { value: "聊完之后，我知道这里是在说反馈。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存清思" }));

    await waitFor(() => {
      expect(summary).toHaveAttribute("aria-label", "打开本页共读记录：1 条，清思 1 条");
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭划线清思" }));
    fireEvent.click(screen.getByRole("button", { name: /本页共读记录/ }));
    expect(screen.getByText("聊完之后，我知道这里是在说反馈。")).toBeInTheDocument();
  });

  it("shares the current page only from the explicit page action", () => {
    const props = makeProps();
    render(<NovelReader {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "和陆沉共读" }));
    expect(props.onSharePage).toHaveBeenCalledWith("第一句话。第二句话。");
  });

  it("uses a single resume bar when the reader is collapsed", () => {
    const props = {
      ...makeProps(),
      session: {
        ...makeProps().session,
        title: "收起阅读测试",
        userCurrentPosition: { kind: "paragraph" as const, index: 2, total: 4, label: "第 2 段" }
      },
      chunks: ["第一段。", "第二段。", "第三段。", "第四段。"],
      canRequestPip: true,
      collapsed: true,
      onExpand: vi.fn()
    };

    render(<NovelReader {...props} />);

    expect(screen.getByRole("main", { name: "已收起的小说阅读器" })).toBeInTheDocument();
    expect(screen.getByText("停在第 2 页，共 4 页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /继续阅读/ }));
    expect(props.onExpand).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "悬浮" }));
    expect(props.onRequestPip).toHaveBeenCalledTimes(1);
  });
});
