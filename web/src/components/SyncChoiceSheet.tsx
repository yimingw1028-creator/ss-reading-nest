import { BookOpen, Clock3, Send, Sparkles, X } from "lucide-react";

export function SyncChoiceSheet(props: {
  assistantLabel: string;
  userLabel: string;
  recentLabel?: string;
  onFull: () => void;
  onCurrent: () => void;
  onRecent: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="sheet-backdrop" role="presentation" onClick={props.onCancel}>
      <section
        className="bottom-sheet sync-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="选择共读同步范围"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-grip" />
        <header className="sheet-header">
          <div>
            <span className="sheet-kicker">共读同步</span>
            <h2>从哪里接上剧情？</h2>
            <p>陆沉停在{props.assistantLabel}，你已经读到{props.userLabel}。</p>
          </div>
          <button type="button" className="icon-button sheet-close" aria-label="取消同步" onClick={props.onCancel}>
            <X aria-hidden="true" strokeWidth={1.8} />
          </button>
        </header>
        <div className="sync-options">
          <button className="action-primary sync-option" onClick={props.onFull}>
            <Sparkles aria-hidden="true" strokeWidth={1.8} />
            <span>
              <strong>完整补课后再陪读（推荐）</strong>
              <small>按顺序补齐缺少的剧情，再开始共读。</small>
            </span>
          </button>
          <button className="sync-option" onClick={props.onCurrent}>
            <Send aria-hidden="true" strokeWidth={1.8} />
            <span>
              <strong>只看当前页</strong>
              <small>最快开始，前面的剧情不会补齐。</small>
            </span>
          </button>
          <button className="sync-option" onClick={props.onRecent}>
            <Clock3 aria-hidden="true" strokeWidth={1.8} />
            <span>
              <strong>{props.recentLabel ?? "补最近 5 页"}</strong>
              <small>先补一小段最近的上下文。</small>
            </span>
          </button>
        </div>
        <p className="sync-privacy-note">
          <BookOpen aria-hidden="true" strokeWidth={1.8} />
          只发送你选择的页段，不会自动发送整本书。
        </p>
      </section>
    </div>
  );
}
