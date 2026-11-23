import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRead, repoSearch, resolveSafePath } from "../src/repo.ts";

let rootDir: string;
let outsideFile: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "oc-remote-mcp-"));
  outsideFile = join(tmpdir(), `outside-${Date.now()}.txt`);
  writeFileSync(outsideFile, "secret\n", "utf8");
  writeFileSync(join(rootDir, "hello.ts"), "export const x = 42;\n", "utf8");
  symlinkSync(outsideFile, join(rootDir, "escape-link.txt"));
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(outsideFile, { force: true });
});

describe("repo sandbox", () => {
  test("reads files inside allowed root", () => {
    const res = repoRead([rootDir], "hello.ts", 1, 10);
    expect(res.content).toContain("1: export const x = 42;");
  });

  test("searches files inside allowed root", async () => {
    const res = await repoSearch([rootDir], "export const x");
    expect(res.match_count).toBeGreaterThanOrEqual(1);
    expect(res.output).toContain("hello.ts");
  });

  test("rejects .. traversal and symlink escapes", () => {
    expect(() => resolveSafePath("../etc/passwd", [rootDir])).toThrow();
    expect(() => resolveSafePath("escape-link.txt", [rootDir])).toThrow(
      /outside allowed workspace roots/,
    );
  });
});
