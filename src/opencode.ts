import type { ModelRef } from "./config.ts";

export interface OpenCodeProject {
  id: string;
  canonical?: string;
  vcs?: string;
}

export interface OpenCodeSession {
  id: string;
  projectID?: string;
  title?: string;
  agent?: string;
  model?: ModelRef;
  outcome?: string;
  time?: {
    created?: number;
    updated?: number;
    busy?: number;
    idle?: number;
  };
  location?: {
    directory?: string;
  };
}

interface RawMessagePart {
  type?: string;
  text?: string;
  toolName?: string;
  name?: string;
  status?: string;
}

interface RawMessage {
  id?: string;
  type?: string;
  outcome?: string;
  time?: { created?: number; completed?: number };
  content?: RawMessagePart[];
}

export interface ParsedMessageSummary {
  hasIdle: boolean;
  outcome?: string;
  latestAssistantText: string;
  recentTools: string[];
  latestCreatedAt?: number;
}

const MAX_REPLY_CHARS = 12_000;
const MAX_DIFF_CHARS = 16_000;

function unwrapData<T>(json: unknown): T {
  if (
    json &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    "data" in json
  ) {
    return (json as { data: T }).data;
  }
  return json as T;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class OpenCodeClient {
  private readonly authHeader?: string;

  constructor(
    private readonly baseUrl: string,
    username = "opencode",
    password?: string,
  ) {
    if (password) {
      const encoded = Buffer.from(`${username}:${password}`).toString("base64");
      this.authHeader = `Basic ${encoded}`;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (this.authHeader) headers.authorization = this.authHeader;
    if (body !== undefined) headers["content-type"] = "application/json";

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `OpenCode API ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async healthCheck(): Promise<OpenCodeProject[]> {
    try {
      return await this.listProjects();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot reach OpenCode at ${this.baseUrl} (${msg}). Make sure OpenCode is running (e.g. "opencode serve").`,
      );
    }
  }

  async listProjects(): Promise<OpenCodeProject[]> {
    const raw = await this.request<unknown>("GET", "/api/project");
    const list = unwrapData<OpenCodeProject[]>(raw);
    return Array.isArray(list) ? list : [];
  }

  async listSessions(limit = 15): Promise<OpenCodeSession[]> {
    const raw = await this.request<unknown>(
      "GET",
      `/api/session?limit=${Math.max(1, Math.min(50, limit))}`,
    );
    const list = unwrapData<OpenCodeSession[]>(raw);
    return Array.isArray(list) ? list : [];
  }

  async getActiveSessions(): Promise<Record<string, unknown>> {
    const raw = await this.request<unknown>("GET", "/api/session/active");
    const map = unwrapData<Record<string, unknown>>(raw);
    return map && typeof map === "object" ? map : {};
  }

  async getSession(sessionId: string): Promise<OpenCodeSession> {
    const raw = await this.request<unknown>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}`,
    );
    return unwrapData<OpenCodeSession>(raw);
  }

  async createSession(input: {
    directory: string;
    title?: string;
    model?: ModelRef;
    agent?: string;
  }): Promise<OpenCodeSession> {
    const body: Record<string, unknown> = {
      location: { directory: input.directory },
    };
    if (input.title) body.title = input.title;
    if (input.model) body.model = input.model;
    if (input.agent) body.agent = input.agent;

    const raw = await this.request<unknown>("POST", "/api/session", body);
    return unwrapData<OpenCodeSession>(raw);
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      { text },
    );
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      {},
    );
  }

  async getPermissions(sessionId: string): Promise<unknown[]> {
    const raw = await this.request<unknown>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/permission`,
    );
    const list = unwrapData<unknown[]>(raw);
    return Array.isArray(list) ? list : [];
  }

  async getMessagesSummary(
    sessionId: string,
    limit = 10,
  ): Promise<ParsedMessageSummary> {
    const raw = await this.request<unknown>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/message?limit=${limit}`,
    );
    const messages = unwrapData<RawMessage[]>(raw);
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        hasIdle: false,
        latestAssistantText: "",
        recentTools: [],
      };
    }

    let hasIdle = false;
    let outcome: string | undefined;
    let latestAssistantText = "";
    const recentTools: string[] = [];

    // Messages are returned newest-first; scan for latest idle & assistant text
    for (const msg of messages) {
      if (msg.type === "idle" && !hasIdle) {
        hasIdle = true;
        outcome = msg.outcome;
      }
      if (msg.type === "assistant" && Array.isArray(msg.content)) {
        const textParts: string[] = [];
        for (const part of msg.content) {
          if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
            textParts.push(part.text);
          } else if (
            (part.type === "tool-invocation" ||
              part.type === "tool_use" ||
              part.type === "tool") &&
            (part.toolName || part.name)
          ) {
            const label = String(part.toolName ?? part.name);
            if (!recentTools.includes(label) && recentTools.length < 12) {
              recentTools.push(label);
            }
          }
        }
        if (!latestAssistantText && textParts.length > 0) {
          latestAssistantText = textParts.join("\n\n");
        }
      }
      if (msg.type === "user") break;
    }

    return {
      hasIdle,
      outcome,
      latestAssistantText: truncateText(latestAssistantText, MAX_REPLY_CHARS),
      recentTools,
      latestCreatedAt: messages[0]?.time?.created,
    };
  }

  async getDiffSummary(sessionId: string): Promise<string> {
    const raw = await this.request<unknown>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/diff`,
    );
    const diffs = unwrapData<unknown>(raw);
    if (!diffs || (Array.isArray(diffs) && diffs.length === 0)) {
      return "";
    }
    const serialized =
      typeof diffs === "string" ? diffs : JSON.stringify(diffs, null, 2);
    return truncateText(serialized, MAX_DIFF_CHARS);
  }

  async pollSession(sessionId: string): Promise<Record<string, unknown>> {
    const [activeMap, session, summary, permissions] = await Promise.all([
      this.getActiveSessions(),
      this.getSession(sessionId),
      this.getMessagesSummary(sessionId, 12),
      this.getPermissions(sessionId).catch(() => []),
    ]);

    const isRunning = Object.prototype.hasOwnProperty.call(activeMap, sessionId);

    if (permissions.length > 0) {
      return {
        status: "needs_permission",
        session_id: sessionId,
        directory: session.location?.directory,
        permissions,
        latest_reply: summary.latestAssistantText,
        recent_tools: summary.recentTools,
      };
    }

    if (isRunning) {
      return {
        status: "running",
        session_id: sessionId,
        directory: session.location?.directory,
        recent_tools: summary.recentTools,
        latest_reply: summary.latestAssistantText,
      };
    }

    const diffSummary = await this.getDiffSummary(sessionId).catch(() => "");
    return {
      status: "completed",
      session_id: sessionId,
      directory: session.location?.directory,
      outcome: summary.outcome ?? session.outcome ?? "unknown",
      reply: summary.latestAssistantText,
      recent_tools: summary.recentTools,
      ...(diffSummary ? { diff_summary: diffSummary } : {}),
    };
  }

  async dispatchAndWait(input: {
    directory: string;
    prompt: string;
    sessionId?: string;
    title?: string;
    model?: ModelRef;
    waitSeconds?: number;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    const waitMs = Math.max(0, Math.min(30, input.waitSeconds ?? 12)) * 1000;

    let sessionId = input.sessionId;
    if (!sessionId) {
      const created = await this.createSession({
        directory: input.directory,
        title: input.title ?? input.prompt.slice(0, 60),
        model: input.model,
      });
      sessionId = created.id;
    }

    await this.sendPrompt(sessionId, input.prompt);

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(1500, input.signal);
      const polled = await this.pollSession(sessionId);
      if (polled.status !== "running") {
        return polled;
      }
    }

    const latest = await this.pollSession(sessionId);
    return {
      ...latest,
      hint:
        latest.status === "running"
          ? "Still running. Call opencode_poll with this session_id to check progress."
          : undefined,
    };
  }
}
