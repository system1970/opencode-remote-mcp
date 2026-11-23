import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";

const MISSING_ROOT = "/definitely/not/a/real/dir-oc-remote-mcp-xyz";

describe("parseConfig --help", () => {
  test("--help returns early without resolving roots or creating a secret", () => {
    const cfg = parseConfig(["--help", "--root", MISSING_ROOT], {});
    expect(cfg.help).toBe(true);
    // Raw and unresolved: resolveRoot would have thrown on this path.
    expect(cfg.roots).toEqual([MISSING_ROOT]);
    // No secret generated/persisted: loadOrCreateSecret would return ~43 chars.
    expect(cfg.secret).toBe("");
  });

  test("-h returns early without validating port or model", () => {
    const cfg = parseConfig(
      ["-h", "--root", MISSING_ROOT, "--port", "99999", "--model", "bogus"],
      {},
    );
    expect(cfg.help).toBe(true);
    expect(cfg.roots).toEqual([MISSING_ROOT]);
  });

  test("--help keeps an explicit secret without persisting anything", () => {
    const cfg = parseConfig(["--help", "--secret", "  abc  "], {});
    expect(cfg.help).toBe(true);
    expect(cfg.secret).toBe("abc");
  });

  test("missing root still throws without --help", () => {
    expect(() =>
      parseConfig(["--root", MISSING_ROOT, "--ephemeral-secret"], {}),
    ).toThrow(/does not exist/);
  });

  test("invalid port still throws without --help", () => {
    expect(() =>
      parseConfig(["--port", "99999", "--ephemeral-secret"], {}),
    ).toThrow(/Invalid --port/);
  });
});
