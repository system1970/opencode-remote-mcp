import { HELP_TEXT, parseConfig } from "./config.ts";
import { McpHttpServer } from "./mcp-http.ts";
import { OpenCodeClient } from "./opencode.ts";
import { buildTools } from "./tools.ts";
import { resolveTunnel } from "./tunnel.ts";

const SERVER_INSTRUCTIONS = [
  "You are connected to the user's local OpenCode instance via opencode-remote-mcp.",
  "Use repo_status, repo_read, repo_search, and repo_diff for fast read-only inspection and code review.",
  "Delegate file edits, builds, tests, and multi-file tasks to OpenCode via opencode_dispatch, then monitor with opencode_poll.",
  "Never ask OpenCode to run git push or destructive git commands unless the user explicitly asks.",
].join(" ");

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const opencode = new OpenCodeClient(
    config.opencodeUrl,
    config.opencodeUsername,
    config.opencodePassword,
  );
  const projects = await opencode.healthCheck();

  const tools = buildTools(config, opencode);
  const mcpServer = new McpHttpServer({
    port: config.port,
    secret: config.secret,
    bearerToken: config.bearerToken,
    serverName: "opencode-remote-mcp",
    serverVersion: "0.1.0",
    instructions: SERVER_INSTRUCTIONS,
    tools,
  });

  const boundPort = await mcpServer.start();
  const localUrl = `http://127.0.0.1:${boundPort}${mcpServer.path}`;

  const tunnel = await resolveTunnel(config.tunnel, boundPort, config.routeName);
  if (tunnel) mcpServer.setPublicUrl(tunnel.publicUrl);
  const publicMcpUrl = tunnel ? `${tunnel.publicUrl}${mcpServer.path}` : undefined;

  process.stdout.write("\n");
  process.stdout.write("opencode-remote-mcp is ready\n");
  process.stdout.write("───────────────────────────\n");
  process.stdout.write(`OpenCode : ${config.opencodeUrl} (${projects.length} projects)\n`);
  process.stdout.write(
    `Model    : ${config.model ? `${config.model.providerID}/${config.model.id}` : "(OpenCode default)"}\n`,
  );
  process.stdout.write(`Roots    : ${config.roots.join(", ")}\n`);
  process.stdout.write(`Tools    : ${tools.length} (${config.readOnly ? "read-only" : "read + dispatch"})\n`);
  if (tunnel) {
    const label =
      tunnel.provider === "opentunnel"
        ? "opentunnel (persistent blind-TLS)"
        : "cloudflare (ephemeral quick tunnel)";
    process.stdout.write(`Tunnel   : ${label}\n`);
  }
  process.stdout.write(`Local    : ${localUrl}\n`);
  if (publicMcpUrl) {
    process.stdout.write(`\nGemini Web / Remote MCP URL (paste into gemini.google.com/devmode):\n`);
    process.stdout.write(`  ${publicMcpUrl}\n`);
  } else {
    process.stdout.write(`\nTunnel disabled (--no-tunnel). Point your HTTPS reverse proxy to:\n`);
    process.stdout.write(`  ${localUrl}\n`);
  }
  process.stdout.write("\nPress Ctrl+C to stop.\n\n");

  const shutdown = async () => {
    process.stderr.write("\nShutting down opencode-remote-mcp...\n");
    await tunnel?.stop();
    await mcpServer.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  process.stderr.write(
    `Error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
