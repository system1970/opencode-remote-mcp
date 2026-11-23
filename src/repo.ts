import { execFile } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_READ_BYTES = 24 * 1024;
const MAX_READ_LINES = 400;
const MAX_DIFF_BYTES = 24 * 1024;
const MAX_SEARCH_BYTES = 16 * 1024;

function isWithinRoot(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveSafePath(
  inputPath: string | undefined,
  allowedRoots: string[],
): string {
  if (allowedRoots.length === 0) {
    throw new Error("No allowed workspace roots configured");
  }

  const raw = inputPath?.trim();
  if (!raw) {
    return allowedRoots[0]!;
  }

  const candidate = isAbsolute(raw)
    ? resolve(raw)
    : resolve(allowedRoots[0]!, raw);

  if (!existsSync(candidate)) {
    // Also check if any other root contains this relative path
    if (!isAbsolute(raw)) {
      for (const root of allowedRoots.slice(1)) {
        const alt = resolve(root, raw);
        if (existsSync(alt)) {
          const realAlt = realpathSync(alt);
          if (allowedRoots.some((r) => isWithinRoot(realAlt, r))) {
            return realAlt;
          }
        }
      }
    }
    throw new Error(`Path does not exist: ${raw}`);
  }

  const real = realpathSync(candidate);
  if (!allowedRoots.some((r) => isWithinRoot(real, r))) {
    throw new Error(`Access denied: "${raw}" is outside allowed workspace roots`);
  }
  return real;
}

async function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
}

function capText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const sliced = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${sliced}\n... [truncated]`;
}

async function inspectGitRepo(dir: string): Promise<Record<string, unknown>> {
  const branchRes = await runCmd(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    dir,
  );
  if (!branchRes.ok) {
    return { path: dir, git: false };
  }
  const [statusRes, diffStatRes] = await Promise.all([
    runCmd("git", ["status", "--short"], dir),
    runCmd("git", ["diff", "--stat"], dir),
  ]);
  return {
    path: dir,
    git: true,
    branch: branchRes.stdout.trim(),
    status: capText(statusRes.stdout.trim(), 4096) || "(clean)",
    ...(diffStatRes.stdout.trim()
      ? { diff_stat: capText(diffStatRes.stdout.trim(), 4096) }
      : {}),
  };
}

export async function repoStatus(
  allowedRoots: string[],
  inputPath?: string,
): Promise<Record<string, unknown>> {
  if (inputPath) {
    const target = resolveSafePath(inputPath, allowedRoots);
    const info = await inspectGitRepo(target);
    return { allowed_roots: allowedRoots, repos: [info] };
  }

  const repos: Record<string, unknown>[] = [];
  for (const root of allowedRoots) {
    if (existsSync(join(root, ".git"))) {
      repos.push(await inspectGitRepo(root));
      continue;
    }
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const sub = join(root, entry.name);
      if (existsSync(join(sub, ".git"))) {
        repos.push(await inspectGitRepo(sub));
      }
    }
  }

  return {
    allowed_roots: allowedRoots,
    repos,
  };
}

export function repoRead(
  allowedRoots: string[],
  inputPath: string,
  startLine = 1,
  endLine = 200,
): Record<string, unknown> {
  const target = resolveSafePath(inputPath, allowedRoots);
  const st = statSync(target);
  if (!st.isFile()) {
    throw new Error(`Not a file: ${inputPath}`);
  }

  const buf = readFileSync(target);
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0)) {
    throw new Error(`Cannot read binary file: ${inputPath}`);
  }

  const lines = buf.toString("utf8").split(/\r?\n/);
  const start = Math.max(1, Math.floor(startLine));
  const clampedEnd = Math.min(
    lines.length,
    Math.max(start, Math.min(Math.floor(endLine), start + MAX_READ_LINES - 1)),
  );

  const numbered: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (let i = start; i <= clampedEnd; i++) {
    const line = `${i}: ${lines[i - 1] ?? ""}`;
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (bytes > MAX_READ_BYTES) {
      truncated = true;
      break;
    }
    numbered.push(line);
  }

  return {
    path: target,
    total_lines: lines.length,
    start_line: start,
    end_line: start + numbered.length - 1,
    truncated: truncated || clampedEnd < Math.floor(endLine),
    content: numbered.join("\n"),
  };
}

export async function repoSearch(
  allowedRoots: string[],
  query: string,
  inputPath?: string,
  glob?: string,
  maxResults = 50,
): Promise<Record<string, unknown>> {
  if (!query.trim()) {
    throw new Error("query must be non-empty");
  }
  const target = resolveSafePath(inputPath, allowedRoots);
  const limit = Math.max(1, Math.min(200, Math.floor(maxResults)));

  const rgArgs = [
    "--no-heading",
    "--line-number",
    "--color=never",
    "--max-count",
    String(limit),
  ];
  if (glob?.trim()) {
    rgArgs.push("--glob", glob.trim());
  }
  rgArgs.push(query, target);

  let res = await runCmd("rg", rgArgs, target);
  if (!res.ok && res.stderr.includes("ENOENT")) {
    const gitArgs = ["grep", "-n", "--max-count", String(limit), query];
    if (glob?.trim()) gitArgs.push("--", glob.trim());
    res = await runCmd("git", gitArgs, target);
  }

  const lines = res.stdout.trim() ? res.stdout.trim().split("\n") : [];
  return {
    path: target,
    query,
    match_count: lines.length,
    output: capText(lines.slice(0, limit).join("\n"), MAX_SEARCH_BYTES),
  };
}

export async function repoDiff(
  allowedRoots: string[],
  inputPath?: string,
  file?: string,
  staged = false,
): Promise<Record<string, unknown>> {
  const target = resolveSafePath(inputPath, allowedRoots);
  const args = ["diff"];
  if (staged) args.push("--staged");
  if (file?.trim()) {
    const safeFile = resolveSafePath(file, allowedRoots);
    args.push("--", relative(target, safeFile));
  }

  const res = await runCmd("git", args, target);
  if (!res.ok) {
    throw new Error(res.stderr || "git diff failed");
  }
  return {
    path: target,
    staged,
    diff: capText(res.stdout, MAX_DIFF_BYTES) || "(no diff)",
  };
}
