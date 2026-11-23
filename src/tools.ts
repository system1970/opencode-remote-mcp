import { statSync } from "node:fs";
import type { Config } from "./config.ts";
import { parseModelFlag } from "./config.ts";
import type { McpToolDefinition } from "./mcp-http.ts";
import type { OpenCodeClient } from "./opencode.ts";
import {
  repoDiff,
  repoRead,
  repoSearch,
  repoStatus,
  resolveSafePath,
} from "./repo.ts";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function buildTools(
  config: Config,
  opencode: OpenCodeClient,
): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [
    {
      name: "repo_status",
      description:
        "List allowed workspace repositories, current git branch, git status, and diff stat.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Optional repository path inside allowed roots. Omit to list all allowed repos.",
          },
        },
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      handler: async (args) =>
        repoStatus(
          config.roots,
          typeof args.path === "string" ? args.path : undefined,
        ),
    },
    {
      name: "repo_read",
      description:
        "Read a text file inside allowed workspace roots with line numbers (max 400 lines / 24 KB per call).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path (absolute or relative to workspace root).",
          },
          start_line: {
            type: "integer",
            description: "1-based start line (default 1).",
          },
          end_line: {
            type: "integer",
            description: "1-based end line (default 200).",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      handler: async (args) => {
        if (typeof args.path !== "string" || !args.path.trim()) {
          throw new Error("path is required");
        }
        return repoRead(
          config.roots,
          args.path,
          typeof args.start_line === "number" ? args.start_line : 1,
          typeof args.end_line === "number" ? args.end_line : 200,
        );
      },
    },
    {
      name: "repo_search",
      description:
        "Search code across allowed workspace roots using ripgrep (or git grep fallback).",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Regex or text pattern to search for.",
          },
          path: {
            type: "string",
            description: "Optional directory or file path inside allowed roots.",
          },
          glob: {
            type: "string",
            description: "Optional file glob filter, e.g. '*.ts' or '*.rs'.",
          },
          max_results: {
            type: "integer",
            description: "Max matching lines to return (default 50, max 200).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      handler: async (args) => {
        if (typeof args.query !== "string" || !args.query.trim()) {
          throw new Error("query is required");
        }
        return repoSearch(
          config.roots,
          args.query,
          typeof args.path === "string" ? args.path : undefined,
          typeof args.glob === "string" ? args.glob : undefined,
          typeof args.max_results === "number" ? args.max_results : 50,
        );
      },
    },
    {
      name: "repo_diff",
      description:
        "Inspect git diff for a repository or specific file inside allowed workspace roots.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository directory inside allowed roots.",
          },
          file: {
            type: "string",
            description: "Optional specific file path to diff.",
          },
          staged: {
            type: "boolean",
            description: "Show staged diff (--staged) instead of working tree.",
          },
        },
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      handler: async (args) =>
        repoDiff(
          config.roots,
          typeof args.path === "string" ? args.path : undefined,
          typeof args.file === "string" ? args.file : undefined,
          args.staged === true,
        ),
    },
    {
      name: "opencode_sessions",
      description:
        "List OpenCode projects, active running sessions, and recent sessions so you can inspect or continue existing work.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "Max recent sessions to return (default 15, max 50).",
          },
        },
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      handler: async (args) => {
        const limit = typeof args.limit === "number" ? args.limit : 15;
        const [projects, sessions, active] = await Promise.all([
          opencode.listProjects(),
          opencode.listSessions(limit),
          opencode.getActiveSessions(),
        ]);
        return {
          active_session_ids: Object.keys(active),
          projects: projects.map((p) => ({
            id: p.id,
            directory: p.canonical,
            vcs: p.vcs,
          })),
          sessions: sessions.map((s) => ({
            id: s.id,
            title: s.title,
            directory: s.location?.directory,
            model: s.model ? `${s.model.providerID}/${s.model.id}` : undefined,
            outcome: s.outcome,
            running: Object.prototype.hasOwnProperty.call(active, s.id),
            updated: s.time?.updated,
          })),
        };
      },
    },
    {
      name: "opencode_poll",
      description:
        "Poll an OpenCode session for its current status (running, completed, needs_permission), latest reply, recent tools, and diff summary.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "OpenCode session ID returned by opencode_dispatch.",
          },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      handler: async (args) => {
        if (typeof args.session_id !== "string" || !args.session_id.trim()) {
          throw new Error("session_id is required");
        }
        return opencode.pollSession(args.session_id.trim());
      },
    },
  ];

  if (!config.readOnly) {
    tools.push(
      {
        name: "opencode_dispatch",
        description:
          "Send a coding, editing, build, or test task to local OpenCode. Waits up to ~12s; if still running, returns status='running' and session_id for opencode_poll.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Clear, actionable instructions for OpenCode.",
            },
            directory: {
              type: "string",
              description:
                "Target repository directory inside allowed roots (required when starting a new session).",
            },
            session_id: {
              type: "string",
              description:
                "Optional existing OpenCode session ID to continue instead of creating a new session.",
            },
            title: {
              type: "string",
              description: "Optional short title for a new session.",
            },
            model: {
              type: "string",
              description:
                "Optional model override as 'provider/model-id' (defaults to CLI --model or OpenCode default).",
            },
            wait_seconds: {
              type: "integer",
              description:
                "Seconds to wait before returning running status (default 12, max 30).",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        handler: async (args, signal) => {
          if (typeof args.prompt !== "string" || !args.prompt.trim()) {
            throw new Error("prompt is required");
          }
          const sessionId =
            typeof args.session_id === "string" && args.session_id.trim()
              ? args.session_id.trim()
              : undefined;
          const rawDir =
            typeof args.directory === "string" && args.directory.trim()
              ? args.directory.trim()
              : undefined;
          const directory = resolveSafePath(rawDir, config.roots);
          if (!statSync(directory).isDirectory()) {
            throw new Error(`directory must be a directory: ${directory}`);
          }
          const model =
            typeof args.model === "string" && args.model.trim()
              ? parseModelFlag(args.model)
              : config.model;

          return opencode.dispatchAndWait({
            directory,
            prompt: args.prompt,
            sessionId,
            title: typeof args.title === "string" ? args.title : undefined,
            model,
            waitSeconds:
              typeof args.wait_seconds === "number" ? args.wait_seconds : 12,
            signal,
          });
        },
      },
      {
        name: "opencode_interrupt",
        description: "Interrupt/abort a currently running OpenCode session.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "OpenCode session ID to interrupt.",
            },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        handler: async (args) => {
          if (typeof args.session_id !== "string" || !args.session_id.trim()) {
            throw new Error("session_id is required");
          }
          await opencode.interrupt(args.session_id.trim());
          return { interrupted: true, session_id: args.session_id.trim() };
        },
      },
    );
  }

  return tools;
}
