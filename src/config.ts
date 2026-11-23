import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export type TunnelMode = "auto" | "opentunnel" | "cloudflare" | "none";

export interface Config {
  roots: string[];
  model?: ModelRef;
  opencodeUrl: string;
  opencodeUsername: string;
  opencodePassword?: string;
  port: number;
  secret: string;
  bearerToken?: string;
  tunnel: TunnelMode;
  routeName?: string;
  readOnly: boolean;
  help: boolean;
}

export function parseModelFlag(raw: string): ModelRef {
  const trimmed = raw.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) {
    throw new Error(
      `Invalid --model "${raw}". Expected "provider/model-id" or "provider/model-id:variant".`,
    );
  }
  const providerID = trimmed.slice(0, slashIdx);
  const rest = trimmed.slice(slashIdx + 1);
  const colonIdx = rest.indexOf(":");
  if (colonIdx > 0 && colonIdx < rest.length - 1) {
    return {
      providerID,
      id: rest.slice(0, colonIdx),
      variant: rest.slice(colonIdx + 1),
    };
  }
  return { providerID, id: rest };
}

function readServicePassword(): string | undefined {
  const servicePath = join(homedir(), ".config", "opencode", "service.json");
  if (!existsSync(servicePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(servicePath, "utf8")) as {
      password?: unknown;
    };
    return typeof parsed.password === "string" && parsed.password.length > 0
      ? parsed.password
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveRoot(dir: string): string {
  const abs = resolve(dir);
  if (!existsSync(abs)) {
    throw new Error(`Root directory does not exist: ${abs}`);
  }
  return realpathSync(abs);
}

function loadOrCreateSecret(explicit?: string, ephemeral = false): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (ephemeral) return randomBytes(32).toString("base64url");

  const dir = join(homedir(), ".config", "opencode-remote-mcp");
  const file = join(dir, "secret");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 16) return existing;
  }

  const generated = randomBytes(32).toString("base64url");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  return generated;
}

function parseTunnelMode(raw: string): TunnelMode {
  if (
    raw === "auto" ||
    raw === "opentunnel" ||
    raw === "cloudflare" ||
    raw === "none"
  ) {
    return raw;
  }
  throw new Error(
    `Invalid --tunnel "${raw}". Use "auto", "opentunnel", "cloudflare", or "none".`,
  );
}

export function parseConfig(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Config {
  const rawRoots: string[] = [];
  let modelRaw = env.OPENCODE_MODEL;
  let opencodeUrl = env.OPENCODE_URL ?? "http://127.0.0.1:49374";
  let opencodeUsername = env.OPENCODE_USERNAME ?? "opencode";
  let opencodePassword = env.OPENCODE_PASSWORD;
  let port = env.PORT ? Number(env.PORT) : 49390;
  let secret = env.MCP_SECRET ?? "";
  let ephemeralSecret = false;
  let bearerToken = env.MCP_BEARER_TOKEN;
  let tunnel: TunnelMode = env.MCP_TUNNEL
    ? parseTunnelMode(env.MCP_TUNNEL)
    : "auto";
  let routeName = env.OPENTUNNEL_ROUTE_NAME;
  let readOnly = env.MCP_READ_ONLY === "1" || env.MCP_READ_ONLY === "true";
  let help = false;

  if (env.OPENCODE_MCP_ROOTS) {
    for (const r of env.OPENCODE_MCP_ROOTS.split(",")) {
      if (r.trim()) rawRoots.push(r.trim());
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`Missing value for ${arg}`);
      return val;
    };

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--root" || arg === "-r") {
      rawRoots.push(next());
    } else if (arg.startsWith("--root=")) {
      rawRoots.push(arg.slice("--root=".length));
    } else if (arg === "--model" || arg === "-m") {
      modelRaw = next();
    } else if (arg.startsWith("--model=")) {
      modelRaw = arg.slice("--model=".length);
    } else if (arg === "--opencode-url") {
      opencodeUrl = next();
    } else if (arg.startsWith("--opencode-url=")) {
      opencodeUrl = arg.slice("--opencode-url=".length);
    } else if (arg === "--opencode-password") {
      opencodePassword = next();
    } else if (arg.startsWith("--opencode-password=")) {
      opencodePassword = arg.slice("--opencode-password=".length);
    } else if (arg === "--port" || arg === "-p") {
      port = Number(next());
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--secret") {
      secret = next();
    } else if (arg.startsWith("--secret=")) {
      secret = arg.slice("--secret=".length);
    } else if (arg === "--ephemeral-secret") {
      ephemeralSecret = true;
    } else if (arg === "--bearer") {
      bearerToken = next();
    } else if (arg.startsWith("--bearer=")) {
      bearerToken = arg.slice("--bearer=".length);
    } else if (arg === "--tunnel") {
      tunnel = parseTunnelMode(next());
    } else if (arg.startsWith("--tunnel=")) {
      tunnel = parseTunnelMode(arg.slice("--tunnel=".length));
    } else if (arg === "--route-name") {
      routeName = next();
    } else if (arg.startsWith("--route-name=")) {
      routeName = arg.slice("--route-name=".length);
    } else if (arg === "--no-tunnel") {
      tunnel = "none";
    } else if (arg === "--read-only") {
      readOnly = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  // --help must not touch the filesystem: no resolveRoot, no secret
  // creation, and no throwing on missing/invalid roots, ports, or models.
  if (help) {
    return {
      roots: [...rawRoots],
      model: undefined,
      opencodeUrl: opencodeUrl.replace(/\/+$/, ""),
      opencodeUsername,
      opencodePassword,
      port,
      secret: secret.trim(),
      bearerToken: bearerToken?.trim() || undefined,
      tunnel,
      routeName: routeName?.trim() || undefined,
      readOnly,
      help,
    };
  }

  opencodePassword ??= readServicePassword();

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${port}`);
  }

  const roots = (rawRoots.length > 0 ? rawRoots : [process.cwd()]).map(resolveRoot);
  const model = modelRaw ? parseModelFlag(modelRaw) : undefined;
  const finalSecret = loadOrCreateSecret(secret, ephemeralSecret);

  return {
    roots,
    model,
    opencodeUrl: opencodeUrl.replace(/\/+$/, ""),
    opencodeUsername,
    opencodePassword,
    port,
    secret: finalSecret,
    bearerToken: bearerToken?.trim() || undefined,
    tunnel,
    routeName: routeName?.trim() || undefined,
    readOnly,
    help,
  };
}

export const HELP_TEXT = `opencode-remote-mcp — Drive local OpenCode from Gemini Web & remote MCP clients

Usage:
  opencode-remote-mcp [options]

Options:
  -r, --root <dir>                    Allowed workspace root (repeatable, default: cwd)
  -m, --model <provider/id>           Default model for new OpenCode sessions (e.g. opencode-go/muse-spark-1.3-contributor)
      --opencode-url <url>            Local OpenCode server URL (default: http://127.0.0.1:49374)
      --opencode-password <pw>        OpenCode server password (default: auto-read ~/.config/opencode/service.json)
  -p, --port <n>                      Local HTTP port (default: 49390, 0 for ephemeral)
      --secret <token>                Custom URL path secret /mcp/<secret> (default: persisted in ~/.config/opencode-remote-mcp/secret)
      --ephemeral-secret              Generate a one-time random secret without saving to disk
      --bearer <token>                Require Authorization: Bearer <token> header
      --tunnel <auto|opentunnel|cloudflare|none>
                                      Tunnel mode (default: auto -> opentunnel if installed, else cloudflare)
      --route-name <name>             Optional OpenTunnel subdomain name
      --no-tunnel                     Disable tunnel (bring your own HTTPS reverse proxy)
      --read-only                     Disable opencode_dispatch and opencode_interrupt
  -h, --help                          Show this help message
`;
