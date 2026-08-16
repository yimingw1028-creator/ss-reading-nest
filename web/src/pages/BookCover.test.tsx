import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_PREFERENCES } from "@ss/shared";
import { BookCover, buildBookArchive } from "./BookCover.js";
import type { BookshelfItem } from "./Home.js";

const item: BookshelfItem = {
  session: {
    id: "book-1",
    title: "雾灯书店",
    type: "novel",
    status: "active",
    userCurrentPosition: { kind: "paragraph", index: 8, label: "第 8 页" },
    assistantSyncedPosition: { kind: "paragraph", index: 6, label: "第 6 页" },
    liveReadingEnabled: true,
    sessionPreferences: DEFAULT_SESSION_PREFERENCES,
    sourceManifest: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    lastReadAt: "2026-07-19T00:00:00.000Z"
  },
  quotes: [
    {
      id: "thought-1",
      sessionId: "book-1",
      content: "请从你真正想记住的地方开始读",
      note: "为什么这句话让我停下来？",
      position: { kind: "paragraph", index: 8, label: "第 8 页" },
      createdAt: "2026-07-19T00:00:00.000Z"
    },
    {
      id: "clarity-1",
      sessionId: "book-1",
      content: "陆沉短评：记住也是一种选择",
      note: "被记住的往往是当时真实的感受。",
      position: { kind: "paragraph", index: 8, label: "第 8 页" },
      createdAt: "2026-07-19T00:00:00.000Z"
    }
  ],
  reactions: [],
  bookmarks: [],
  sourceAvailability: "available_local"
};

describe("BookCover", () => {
  it("classifies saved ideas and companion excerpts with the new names", () => {
    const archive = buildBookArchive(item);

    expect(archive.thought).toHaveLength(1);
    expect(archive.clarity).toHaveLength(1);
    expect(archive.minutes).toHaveLength(0);
    expect(archive.afterword).toHaveLength(0);
  });

  it("shows only populated archive categories and enters the book from its cover", () => {
    const onRead = vi.fn();
    renderCover({ onRead });

    expect(screen.getByText("意绪")).toBeInTheDocument();
    expect(screen.getByText("清思")).toBeInTheDocument();
    expect(screen.queryByText("纪要")).not.toBeInTheDocument();
    expect(screen.queryByText("阅后录")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续阅读《雾灯书店》" }));
    expect(onRead).toHaveBeenCalledWith(item);
  });

  it("keeps a long full title in the profile while shortening the physical cover", () => {
    const longTitle =
      "雾灯书店：在雨停之前读完一封很长很长的信，然后从下一页继续出发";
    const longTitleItem = {
      ...item,
      session: { ...item.session, title: longTitle }
    };

    renderCover({ item: longTitleItem });

    const cover = screen.getByRole("button", { name: `继续阅读《${longTitle}》` });
    expect(within(cover).getByText("雾灯书店")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: longTitle })).toBeInTheDocument();
    expect(document.querySelector(".cover-stage")).toHaveClass("cover-title-long");
  });

  it("expands an entry on one click and jumps on double click", () => {
    const onJump = vi.fn();
    renderCover({ onJump });

    fireEvent.click(screen.getByRole("button", { name: "查看书内记录" }));
    const entry = screen.getByRole("button", { name: /请从你真正想记住的地方开始读/ });
    fireEvent.click(entry);
    expect(screen.getByText("为什么这句话让我停下来？")).toBeInTheDocument();

    fireEvent.doubleClick(entry);
    expect(onJump).toHaveBeenCalledWith(item, item.quotes[0]!.position);
  });

  it("requires confirmation before deleting a book archive entry", async () => {
    const onDeleteEntry = vi.fn().mockResolvedValue(true);
    renderCover({ onDeleteEntry });

    fireEvent.click(screen.getByRole("button", { name: "查看书内记录" }));
    const deleteButton = screen.getByRole("button", {
      name: /删除意绪：请从你真正想记住的地方开始读/
    });
    fireEvent.click(deleteButton);
    expect(onDeleteEntry).not.toHaveBeenCalled();
    fireEvent.click(deleteButton);

    expect(onDeleteEntry).toHaveBeenCalledWith(item, {
      source: "quote",
      recordId: "thought-1"
    });
  });
});

function renderCover(overrides: Partial<Parameters<typeof BookCover>[0]> = {}) {
  return render(
    <BookCover
      item={item}
      onBack={vi.fn()}
      onRead={vi.fn()}
      onReimport={vi.fn()}
      onManage={vi.fn()}
      onJump={vi.fn()}
      {...overrides}
    />
  );
}
