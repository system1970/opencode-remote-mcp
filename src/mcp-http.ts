import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync, inflateSync } from "node:zlib";

const ICON_PNG: Buffer | undefined = (() => {
  try {
    return readFileSync(new URL("../assets/opencode-icon.png", import.meta.url));
  } catch {
    return undefined;
  }
})();
const ICON_DATA_URI = ICON_PNG
  ? `data:image/png;base64,${ICON_PNG.toString("base64")}`
  : undefined;

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  handler: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

export interface McpHttpServerOptions {
  port: number;
  secret: string;
  bearerToken?: string;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  tools: McpToolDefinition[];
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
    "access-control-allow-headers":
      "content-type, authorization, mcp-session-id, mcp-protocol-version",
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error("Request body exceeds 2 MiB limit"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        try {
          const raw = Buffer.concat(chunks);
          const enc = String(req.headers["content-encoding"] ?? "").toLowerCase().trim();
          const buf =
            enc === "gzip"
              ? gunzipSync(raw)
              : enc === "deflate"
                ? inflateSync(raw)
                : raw;
          resolve(buf.toString("utf8"));
        } catch (err) {
          reject(err);
        }
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

export class McpHttpServer {
  private server: Server | undefined;
  private boundPort = 0;
  private readonly toolMap = new Map<string, McpToolDefinition>();

  constructor(private readonly options: McpHttpServerOptions) {
    for (const tool of options.tools) {
      this.toolMap.set(tool.name, tool);
    }
  }

  setPublicUrl(_url: string): void {
    // Retained for backwards compatibility (cli.ts calls it with the tunnel
    // URL). Icons are always embedded as data: URIs for Gemini Web CSP, so
    // there is nothing to store.
  }

  private resolveIconSrc(_req?: IncomingMessage): string | undefined {
    // Gemini Web enforces a restrictive img-src CSP (Google hosts + data:/blob:
    // only), so arbitrary https:// icon URLs are blocked with
    // "violates the following Content Security Policy directive: img-src ...".
    // Always return the embedded data: URI, which is CSP-allowed and avoids an
    // extra fetch. /icon.png is still served for clients that prefer a URL.
    return ICON_DATA_URI;
  }

  get port(): number {
    return this.boundPort;
  }

  get path(): string {
    return `/mcp/${this.options.secret}`;
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort;

    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          writeJson(res, 500, {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
            },
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 70_000;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && this.options.port !== 0) {
          server.listen(0, "127.0.0.1");
          return;
        }
        reject(err);
      };
      server.once("error", onError);
      server.listen(this.options.port, "127.0.0.1", () => {
        server.off("error", onError);
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to bind HTTP server"));
          return;
        }
        this.boundPort = addr.port;
        resolve();
      });
    });

    this.server = server;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
        "access-control-allow-headers":
          "content-type, authorization, mcp-session-id, mcp-protocol-version",
      });
      res.end();
      return;
    }

    const rawUrl = req.url ?? "/";
    const pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
    const normalizedPath = pathname.replace(/\/+$/, "") || "/";

    if (
      ICON_PNG &&
      (req.method === "GET" || req.method === "HEAD") &&
      (normalizedPath === "/favicon.ico" ||
        normalizedPath === "/favicon.png" ||
        normalizedPath === "/icon.png")
    ) {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(ICON_PNG.length),
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      });
      res.end(req.method === "HEAD" ? undefined : ICON_PNG);
      return;
    }

    if (!safeEqual(normalizedPath, this.path)) {
      const safePath = normalizedPath.replace(/\/mcp\/[^/]+/g, "/mcp/<redacted>");
      process.stderr.write(`[mcp] ${req.method ?? "?"} ${safePath} -> 404\n`);
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    process.stderr.write(
      `[mcp] <-- ${req.method ?? "?"} /mcp/<secret> accept=${req.headers.accept ?? "-"} ce=${req.headers["content-encoding"] ?? "-"}\n`,
    );

    if (this.options.bearerToken) {
      const auth = req.headers.authorization ?? "";
      const expected = `Bearer ${this.options.bearerToken}`;
      if (!safeEqual(auth, expected)) {
        writeJson(
          res,
          401,
          { error: "Unauthorized" },
          { "www-authenticate": 'Bearer realm="opencode-remote-mcp"' },
        );
        return;
      }
    }

    if (req.method === "GET") {
      process.stderr.write(`[mcp] GET -> 405\n`);
      writeJson(res, 405, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "SSE stream not supported; use POST." },
      });
      return;
    }

    if (req.method === "DELETE") {
      process.stderr.write(`[mcp] DELETE -> 200\n`);
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== "POST") {
      process.stderr.write(`[mcp] ${req.method ?? "?"} -> 405\n`);
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid body";
      process.stderr.write(`[mcp] body error -> 413: ${msg}\n`);
      writeJson(res, 413, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: msg,
        },
      });
      return;
    }

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(rawBody) as JsonRpcRequest;
    } catch {
      process.stderr.write(`[mcp] parse error -> 400 (len=${rawBody.length})\n`);
      writeJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    // JSON-RPC notifications have no id
    if (msg.id === undefined) {
      process.stderr.write(`[mcp] notification ${msg.method ?? "(unknown)"} -> 202\n`);
      res.writeHead(202, {
        "access-control-allow-origin": "*",
        "content-length": "0",
      });
      res.end();
      return;
    }

    const startedAt = Date.now();
    const method = msg.method ?? "";
    const sessionHeader =
      typeof req.headers["mcp-session-id"] === "string"
        ? req.headers["mcp-session-id"]
        : undefined;
    const sessionExtra: Record<string, string> = sessionHeader
      ? { "mcp-session-id": sessionHeader }
      : {};

    if (method === "initialize") {
      const requestedVersion =
        typeof msg.params?.protocolVersion === "string"
          ? msg.params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      const protocolVersion = (
        SUPPORTED_PROTOCOL_VERSIONS as readonly string[]
      ).includes(requestedVersion)
        ? requestedVersion
        : DEFAULT_PROTOCOL_VERSION;
      const sessionId = sessionHeader ?? randomUUID();
      const iconSrc = this.resolveIconSrc(req);
      const iconLog = !iconSrc
        ? "-"
        : iconSrc.startsWith("data:")
          ? "data:image/png;base64,..."
          : iconSrc;

      process.stderr.write(
        `[mcp] initialize (${protocolVersion}, ${Date.now() - startedAt}ms, icon=${iconLog})\n`,
      );
      writeJson(
        res,
        200,
        {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: this.options.serverName ?? "opencode-remote-mcp",
              title: "OpenCode Remote MCP",
              version: this.options.serverVersion ?? "0.1.0",
              ...(iconSrc
                ? {
                    icons: [
                      {
                        src: iconSrc,
                        mimeType: "image/png",
                        sizes: ["128x128"],
                      },
                    ],
                  }
                : {}),
            },
            ...(this.options.instructions
              ? { instructions: this.options.instructions }
              : {}),
          },
        },
        { "mcp-session-id": sessionId },
      );
      return;
    }

    if (method === "ping" || method === "server/discover" || method === "logging/setLevel") {
      writeJson(res, 200, { jsonrpc: "2.0", id: msg.id, result: {} }, sessionExtra);
      return;
    }

    if (method === "resources/list") {
      writeJson(res, 200, { jsonrpc: "2.0", id: msg.id, result: { resources: [] } }, sessionExtra);
      return;
    }

    if (method === "resources/templates/list") {
      writeJson(
        res,
        200,
        { jsonrpc: "2.0", id: msg.id, result: { resourceTemplates: [] } },
        sessionExtra,
      );
      return;
    }

    if (method === "prompts/list") {
      writeJson(res, 200, { jsonrpc: "2.0", id: msg.id, result: { prompts: [] } }, sessionExtra);
      return;
    }

    if (method === "tools/list") {
      process.stderr.write(
        `[mcp] tools/list (${this.options.tools.length} tools, ${Date.now() - startedAt}ms)\n`,
      );
      writeJson(
        res,
        200,
        {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: this.options.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
          },
        },
        sessionExtra,
      );
      return;
    }

    if (method === "tools/call") {
      const params = msg.params ?? {};
      const toolName = typeof params.name === "string" ? params.name : "";
      const tool = this.toolMap.get(toolName);
      if (!tool) {
        writeJson(
          res,
          200,
          {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
          },
          sessionExtra,
        );
        return;
      }

      const args =
        params.arguments &&
        typeof params.arguments === "object" &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once("close", onClose);
      res.once("close", onClose);

      try {
        const result = await tool.handler(args, controller.signal);
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        process.stderr.write(
          `[mcp] tools/call ${toolName} (${Date.now() - startedAt}ms)\n`,
        );
        writeJson(
          res,
          200,
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text }],
              isError: false,
            },
          },
          sessionExtra,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[mcp] tools/call ${toolName} ERROR: ${message} (${Date.now() - startedAt}ms)\n`,
        );
        writeJson(
          res,
          200,
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: `Error: ${message}` }],
              isError: true,
            },
          },
          sessionExtra,
        );
      } finally {
        req.off("close", onClose);
        res.off("close", onClose);
      }
      return;
    }

    process.stderr.write(`[mcp] unknown method ${method} -> -32601\n`);
    writeJson(res, 200, {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }, sessionExtra);
  }
}
