import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";

describe("server app", () => {
  it("reports health without requiring an API key", async () => {
    const response = await request(createApp()).get("/health");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ ok: true, app: "阿雾和陆沉的共读小巢", version: "0.3.34" });
  });

  it("accepts an MCP initialize request", async () => {
    const response = await request(createApp())
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" }
        }
      });

    expect(response.status).toBe(200);
    expect(response.headers["mcp-session-id"]).toBeTruthy();
  });
});
