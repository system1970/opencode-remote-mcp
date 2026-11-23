import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { TunnelMode } from "./config.ts";

const execFileAsync = promisify(execFile);

export interface TunnelHandle {
  provider: "opentunnel" | "cloudflare";
  publicUrl: string;
  stop: () => Promise<void>;
}

const TRY_CLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const OPENTUNNEL_HOST_RE = /(?:https:\/\/)?([a-z0-9-]+\.[a-z0-9-]+\.opentunnel\.xyz)/i;

async function hasBinary(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(cmd, ["--version"], { timeout: 3000 });
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code !== "ENOENT";
  }
}

export async function startOpenTunnel(
  localPort: number,
  routeName?: string,
): Promise<TunnelHandle> {
  const args = ["route", "add", String(localPort)];
  if (routeName) args.push("--name", routeName);

  let combined = "";
  try {
    const { stdout, stderr } = await execFileAsync("opentunnel", args, {
      timeout: 30_000,
    });
    combined = `${stdout}\n${stderr}`;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    if (e.code === "ENOENT") {
      throw new Error(
        `"opentunnel" binary not found in PATH. Install via: curl -fsSL https://opentunnel.xyz/install | sh`,
      );
    }
    throw new Error(
      `opentunnel route add failed: ${e.stderr || e.message}`,
    );
  }

  let match = combined.match(OPENTUNNEL_HOST_RE);
  if (!match) {
    const listRes = await execFileAsync("opentunnel", ["route", "list"], {
      timeout: 10_000,
    });
    const line = listRes.stdout
      .split("\n")
      .find((l) => l.includes(`127.0.0.1:${localPort}`));
    match = line?.match(OPENTUNNEL_HOST_RE) ?? null;
  }

  if (!match) {
    throw new Error(
      `Could not parse OpenTunnel URL from output:\n${combined.slice(0, 400)}`,
    );
  }

  return {
    provider: "opentunnel",
    publicUrl: `https://${match[1]}`,
    stop: async () => {
      // Keep the route registered so the URL stays persistent across restarts;
      // stopping the local HTTP server already closes external access.
    },
  };
}

export function startCloudflareQuickTunnel(
  localPort: number,
  timeoutMs = 20_000,
  spawnImpl: typeof spawn = spawn,
): Promise<TunnelHandle> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      "cloudflared",
      ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let settled = false;
    let logs = "";
    const MAX_LOG_CHARS = 8_000;

    function cleanup(): void {
      clearTimeout(timer);
      child.stdout?.removeListener("data", onChunk);
      child.stderr?.removeListener("data", onChunk);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      // Discard any further output so the child never blocks on a full pipe.
      child.stdout?.resume();
      child.stderr?.resume();
    }

    function onChunk(chunk: Buffer | string): void {
      if (settled) return;
      logs += chunk.toString();
      if (logs.length > MAX_LOG_CHARS) logs = logs.slice(-MAX_LOG_CHARS);
      const match = logs.match(TRY_CLOUDFLARE_RE);
      if (match && !settled) {
        settled = true;
        const publicUrl = match[0];
        logs = "";
        cleanup();
        resolve({
          provider: "cloudflare",
          publicUrl,
          stop: () =>
            new Promise<void>((res) => {
              if (child.killed || child.exitCode !== null) {
                res();
                return;
              }
              let done = false;
              let killTimer: ReturnType<typeof setTimeout>;
              const onStopExit = () => {
                if (done) return;
                done = true;
                clearTimeout(killTimer);
                res();
              };
              killTimer = setTimeout(() => {
                if (done) return;
                done = true;
                try {
                  if (child.exitCode === null) child.kill("SIGKILL");
                } catch {
                  // Child already gone; nothing to kill.
                }
                child.removeListener("exit", onStopExit);
                res();
              }, 2000);
              child.once("exit", onStopExit);
              try {
                child.kill("SIGTERM");
              } catch {
                onStopExit();
              }
            }),
        });
      }
    }

    function onError(err: Error): void {
      if (settled) return;
      settled = true;
      const tail = logs.slice(-600);
      logs = "";
      cleanup();
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `"cloudflared" binary not found in PATH. Install cloudflared or pass --no-tunnel to use your own HTTPS tunnel.`,
          ),
        );
        return;
      }
      reject(err);
    }

    function onExit(code: number | null): void {
      if (settled) return;
      settled = true;
      const tail = logs.slice(-600);
      logs = "";
      cleanup();
      reject(
        new Error(
          `cloudflared exited unexpectedly with code ${code}.\n${tail}`,
        ),
      );
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const tail = logs.slice(-600);
      logs = "";
      cleanup();
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore kill failures during timeout teardown.
      }
      reject(
        new Error(
          `Timed out waiting for cloudflared tunnel URL after ${timeoutMs}ms.\n${tail}`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function resolveTunnel(
  mode: TunnelMode,
  localPort: number,
  routeName?: string,
): Promise<TunnelHandle | undefined> {
  if (mode === "none") return undefined;
  if (mode === "opentunnel") return startOpenTunnel(localPort, routeName);
  if (mode === "cloudflare") return startCloudflareQuickTunnel(localPort);

  // auto: prefer opentunnel (persistent blind-TLS URL), fall back to cloudflared
  if (await hasBinary("opentunnel")) {
    process.stderr.write("Starting OpenTunnel (persistent blind-TLS)...\n");
    return startOpenTunnel(localPort, routeName);
  }
  if (await hasBinary("cloudflared")) {
    process.stderr.write("Starting Cloudflare Quick Tunnel...\n");
    return startCloudflareQuickTunnel(localPort);
  }

  throw new Error(
    [
      "No tunnel binary found (checked opentunnel and cloudflared).",
      "Install OpenTunnel (recommended, persistent URL): curl -fsSL https://opentunnel.xyz/install | sh",
      "Or install cloudflared, or pass --no-tunnel to use your own HTTPS reverse proxy.",
    ].join("\n"),
  );
}
