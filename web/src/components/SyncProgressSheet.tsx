import { getActiveBatch } from "../features/reading-sync/job-state.js";
import type { ReadingSyncJob } from "../features/reading-sync/types.js";
import { Check, RefreshCw, Sparkles, X } from "lucide-react";

export function SyncProgressSheet(props: {
  job: ReadingSyncJob;
  onConfirm: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const batch = getActiveBatch(props.job);
  const unit = "页";
  return (
    <div className="sheet-backdrop" role="presentation">
      <section className="bottom-sheet sync-sheet" role="dialog" aria-modal="true" aria-label="陆沉补课进度">
        <div className="sheet-grip" />
        <header className="sheet-header">
          <div>
            <span className="sheet-kicker">共读同步</span>
            <h2>陆沉补课中</h2>
            <p>已确认到 {props.job.confirmedThrough?.label ?? "起点"}</p>
          </div>
          <button type="button" className="icon-button sheet-close" aria-label="取消补课" onClick={props.onCancel}>
            <X aria-hidden="true" strokeWidth={1.8} />
          </button>
        </header>
        {batch ? (
          <div className="sync-progress-card">
            <Sparkles aria-hidden="true" strokeWidth={1.8} />
            <span>
              <strong>第 {batch.rangeStart}–{batch.rangeEnd} {unit}</strong>
              <small>{batch.isFinal ? "这是最后一批" : "确认后继续发送下一批"}</small>
            </span>
          </div>
        ) : null}
        {batch?.status === "sent-awaiting-confirmation" ? (
          <button className="action-primary" onClick={props.onConfirm}>
            <Check aria-hidden="true" strokeWidth={1.8} />
            我看到陆沉回复“已读到第 {batch.rangeEnd} {unit}”，
            {batch.isFinal ? "开始正式陪读" : "发送下一批"}
          </button>
        ) : null}
        {batch?.status === "failed" ? (
          <button className="sheet-action" onClick={props.onRetry}>
            <RefreshCw aria-hidden="true" strokeWidth={1.8} />
            重试本批
          </button>
        ) : null}
      </section>
    </div>
  );
}
