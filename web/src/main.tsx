import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { READING_NEST_RESOURCE_VERSION } from "@ss/shared";
import { Boot } from "./Boot.js";
import { initializeReadingHostBridge } from "./bridge/host.js";
import "./styles/tokens.css";
import "./styles/app.css";

const rootElement = document.getElementById("root");

document.documentElement.dataset.hostEmbedding =
  window.parent === window ? "standalone" : "embedded";

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <Boot />
    </StrictMode>
  );
  queueMicrotask(initializeReadingHostBridge);
} else {
  document.body.insertAdjacentHTML(
    "afterbegin",
      `<main class="boot-diagnostics" role="alert"><strong>阿雾和陆沉的共读小巢加载状态</strong><p>Missing app root. Please refresh the widget.</p><dl><div><dt>resourceVersion</dt><dd>${READING_NEST_RESOURCE_VERSION}</dd></div><div><dt>bootStage</dt><dd>missing-root</dd></div></dl></main>`
  );
}
