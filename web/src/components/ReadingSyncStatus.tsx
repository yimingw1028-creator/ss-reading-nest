import type { ReadingSession } from "@ss/shared";

export function ReadingSyncStatus({ session }: { session: ReadingSession }) {
  const user = session.userCurrentPosition;
  const assistant = session.assistantSyncedPosition;
  const pendingStart = (assistant?.index ?? 0) + 1;
  const hasGap = pendingStart <= user.index;

  return (
    <aside className="sync-status" aria-label="陪读同步状态">
      <span>阿雾读到：{user.label}</span>
      <span>陆沉确认读到：{assistant?.label ?? "尚未同步"}</span>
      {hasGap ? (
        <span>
          待补课：第 {pendingStart}–{user.index} 页
        </span>
      ) : null}
    </aside>
  );
}
