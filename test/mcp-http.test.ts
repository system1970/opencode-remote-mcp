import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { McpHttpServer } from "../src/mcp-http.ts";

let server: McpHttpServer;
let baseUrl: string;
const SECRET = "test-secret-token-123";

beforeAll(async () => {
  server = new McpHttpServer({
    port: 0,
    secret: SECRET,
    bearerToken: "bearer-xyz",
    tools: [
      {
        name: "ping_tool",
        description: "Test tool",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        handler: async () => ({ ok: true }),
      },
    ],
  });
  const port = await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.stop();
});

describe("McpHttpServer", () => {
  test("returns 404 on wrong secret path and well-known paths", async () => {
    const r1 = await fetch(`${baseUrl}/mcp/wrong`, { method: "POST" });
    expect(r1.status).toBe(404);

    const r2 = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(r2.status).toBe(404);
  });

  test("returns 401 when bearer token is missing or wrong", async () => {
    const r1 = await fetch(`${baseUrl}/mcp/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r1.status).toBe(401);
  });

  test("handles initialize, tools/list, and tools/call", async () => {
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer bearer-xyz",
    };

    const initRes = await fetch(`${baseUrl}/mcp/${SECRET}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get("mcp-session-id")).toBeTruthy();
    const initJson = (await initRes.json()) as {
      result: {
        protocolVersion: string;
        serverInfo: {
          name: string;
          icons?: Array<{ mimeType: string }>;
        };
      };
    };
    expect(initJson.result.protocolVersion).toBe("2025-06-18");
    expect(initJson.result.serverInfo.name).toBe("opencode-remote-mcp");
    expect(initJson.result.serverInfo.icons?.[0]?.mimeType).toBe("image/png");
    // Plain 127.0.0.1 request (no public host): falls back to data: URI.
    expect(
      (initJson.result.serverInfo as { icons?: Array<{ src: string }> }).icons?.[0]
        ?.src.startsWith("data:image/png;base64,"),
    ).toBe(true);

    const favRes = await fetch(`${baseUrl}/favicon.ico`);
    expect(favRes.status).toBe(200);
    expect(favRes.headers.get("content-type")).toBe("image/png");
    expect((await favRes.arrayBuffer()).byteLength).toBeGreaterThan(100);

    const iconRes = await fetch(`${baseUrl}/icon.png`);
    expect(iconRes.status).toBe(200);
    expect(iconRes.headers.get("content-type")).toBe("image/png");
    expect(iconRes.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );

    const fwdInitRes = await fetch(`${baseUrl}/mcp/${SECRET}`, {
      method: "POST",
      headers: {
        ...headers,
        "x-forwarded-host": "demo.opentunnel.xyz",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      }),
    });
    const fwdJson = (await fwdInitRes.json()) as {
      result: { serverInfo: { icons?: Array<{ src: string }> } };
    };
    // Forwarded hosts and setPublicUrl() used to yield https:// icon URLs, but
    // Gemini Web CSP blocks arbitrary https: hosts (img-src allows Google
    // hosts + data:/blob: only), so initialize always returns the embedded
    // data: URI now.
    expect(fwdJson.result.serverInfo.icons?.[0]?.src.startsWith("data:image/png;base64,")).toBe(
      true,
    );

    const listRes = await fetch(`${baseUrl}/mcp/${SECRET}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const listJson = (await listRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listJson.result.tools.map((t) => t.name)).toEqual(["ping_tool"]);

    for (const [m, key] of [
      ["resources/list", "resources"],
      ["resources/templates/list", "resourceTemplates"],
      ["prompts/list", "prompts"],
    ] as const) {
      const r = await fetch(`${baseUrl}/mcp/${SECRET}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 20, method: m }),
      });
      expect(r.status).toBe(200);
      const j = (await r.json()) as { result: Record<string, unknown[]> };
      expect(j.result[key]).toEqual([]);
    }

    const callRes = await fetch(`${baseUrl}/mcp/${SECRET}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "ping_tool", arguments: {} },
      }),
    });
    const callJson = (await callRes.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(callJson.result.isError).toBe(false);
    expect(callJson.result.content[0]?.text).toContain('"ok": true');
  });

  test("echoes mcp-session-id on tools/list and tools/call", async () => {
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer bearer-xyz",
      "mcp-session-id": "test-session-123",
    };

    const listRes = await fetch(`${baseUrl}/mcp/${SECRET}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list" }),
    });
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("mcp-session-id")).toBe("test-session-123");

    const callRes = await fetch(`${baseUrl}/mcp/${SECRET}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: { name: "ping_tool", arguments: {} },
      }),
    });
    expect(callRes.status).toBe(200);
    expect(callRes.headers.get("mcp-session-id")).toBe("test-session-123");

    const unknownRes = await fetch(`${baseUrl}/mcp/${SECRET}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} },
      }),
    });
    expect(unknownRes.status).toBe(200);
    expect(unknownRes.headers.get("mcp-session-id")).toBe("test-session-123");

    // Error case: handler throws, session id must still be echoed.
    const errServer = new McpHttpServer({
      port: 0,
      secret: SECRET,
      bearerToken: "bearer-xyz",
      tools: [
        {
          name: "boom",
          description: "Always fails",
          inputSchema: { type: "object", properties: {} },
          handler: async () => {
            throw new Error("kaboom");
          },
        },
      ],
    });
    const errPort = await errServer.start();
    try {
      const errRes = await fetch(`http://127.0.0.1:${errPort}/mcp/${SECRET}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 103,
          method: "tools/call",
          params: { name: "boom", arguments: {} },
        }),
      });
      expect(errRes.status).toBe(200);
      expect(errRes.headers.get("mcp-session-id")).toBe("test-session-123");
      const errJson = (await errRes.json()) as {
        result: { isError: boolean };
      };
      expect(errJson.result.isError).toBe(true);
    } finally {
      await errServer.stop();
    }
  });

  test("/.well-known/oauth-protected-resource/mcp/<secret> 404s without leaking the secret", async () => {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write =
      ((chunk: unknown, ...rest: unknown[]) => {
        chunks.push(String(chunk));
        return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stderr.write;
    try {
      const r = await fetch(
        `${baseUrl}/.well-known/oauth-protected-resource/mcp/${SECRET}`,
      );
      expect(r.status).toBe(404);
    } finally {
      process.stderr.write = origWrite;
    }
    const logged = chunks.join("");
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain("/mcp/<redacted>");
  });

  test("initialize stderr log includes redacted icon src", async () => {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write =
      ((chunk: unknown, ...rest: unknown[]) => {
        chunks.push(String(chunk));
        return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stderr.write;
    try {
      const res = await fetch(`${baseUrl}/mcp/${SECRET}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer bearer-xyz",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 200,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      process.stderr.write = origWrite;
    }
    const logged = chunks.join("");
    expect(logged).toContain("[mcp] initialize (");
    expect(logged).toContain("icon=data:image/png;base64,...");
    expect(logged).not.toContain("data:image/png;base64,iVBOR");
  });

  test("setPublicUrl still yields embedded data: icon (Gemini CSP-safe)", async () => {
    const s2 = new McpHttpServer({
      port: 0,
      secret: SECRET,
      tools: [],
    });
    // Trailing slashes are normalized by setPublicUrl.
    s2.setPublicUrl("https://tunnel.example.com///");
    const port2 = await s2.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port2}/mcp/${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        result: { serverInfo: { icons?: Array<{ src: string }> } };
      };
      expect(json.result.serverInfo.icons?.[0]?.src.startsWith("data:image/png;base64,")).toBe(
        true,
      );
    } finally {
      await s2.stop();
    }
  });
});

describe("parseConfig", () => {
  test("parses tunnel modes and route-name", () => {
    const def = parseConfig(["--ephemeral-secret"], {});
    expect(def.tunnel).toBe("auto");

    const ot = parseConfig(
      ["--tunnel", "opentunnel", "--route-name", "my-oc", "--ephemeral-secret"],
      {},
    );
    expect(ot.tunnel).toBe("opentunnel");
    expect(ot.routeName).toBe("my-oc");

    const cf = parseConfig(["--tunnel=cloudflare", "--ephemeral-secret"], {});
    expect(cf.tunnel).toBe("cloudflare");

    const none = parseConfig(["--no-tunnel", "--ephemeral-secret"], {});
    expect(none.tunnel).toBe("none");
  });
});
