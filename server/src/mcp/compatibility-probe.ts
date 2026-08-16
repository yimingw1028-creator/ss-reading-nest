export function createReadingNestCompatibilityProbeHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>阿雾和陆沉的共读小巢 App 检查</title>
<style>
  html,body{margin:0;background:#fffaf6;color:#2d2420;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{box-sizing:border-box;min-height:180px;padding:24px;display:grid;align-content:center;gap:10px}
  strong{font-size:21px}.ok{color:#2e6244;font-weight:750}.muted{color:#786962;font-size:13px;line-height:1.55}
</style>
</head>
<body>
<main>
  <strong>阿雾和陆沉的共读小巢 App 组件已显示</strong>
  <span class="ok">基础渲染正常</span>
  <span id="bridge" class="muted">正在检查 ChatGPT 连接…</span>
</main>
<script>
  try {
    document.getElementById("bridge").textContent = window.openai
      ? "ChatGPT 连接正常。请把这个页面截图发回对话。"
      : "组件已经显示，但连接信息尚未注入。请把这个页面截图发回对话。";
  } catch (_) {
    // The static success text above is intentionally enough to diagnose iframe rendering.
  }
</script>
</body>
</html>`;
}
