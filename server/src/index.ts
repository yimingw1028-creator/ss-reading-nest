import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
createApp().listen(port, () => {
  console.log(`阿雾和陆沉的共读小巢 MCP server: http://localhost:${port}/mcp`);
});
