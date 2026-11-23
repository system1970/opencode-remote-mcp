import { describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { startCloudflareQuickTunnel } from "../src/tunnel.ts";

interface FakeStdio extends EventEmitter {
  resumeCalls: number;
  resume: () => void;
}

interface FakeChild extends EventEmitter {
  stdout: FakeStdio;
  stderr: FakeStdio;
  killed: boolean;
  exitCode: number | null;
  killCalls: string[];
  exitOnTerm: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

function makeStdio(): FakeStdio {
  const s = new EventEmitter() as FakeStdio;
  s.resumeCalls = 0;
  s.resume = () => {
    s.resumeCalls += 1;
  };
  return s;
}

function makeFakeChild(exitOnTerm = true): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = makeStdio();
  child.stderr = makeStdio();
  child.killed = false;
  child.exitCode = null;
  child.killCalls = [];
  child.exitOnTerm = exitOnTerm;
  child.kill = (signal?: NodeJS.Signals | number) => {
    child.killCalls.push(String(signal ?? ""));
    if (signal === "SIGTERM" && child.exitOnTerm && child.exitCode === null) {
      child.killed = true;
      queueMicrotask(() => {
        if (child.exitCode === null) {
          child.exitCode = 0;
          child.emit("exit", 0);
        }
      });
    }
    return true;
  };
  return child;
}

function spawnStub(child: FakeChild): typeof spawn {
  return (() => child) as unknown as typeof spawn;
}

function listenerCounts(child: FakeChild) {
  return {
    stdoutData: child.stdout.listenerCount("data"),
    stderrData: child.stderr.listenerCount("data"),
    error: child.listenerCount("error"),
    exit: child.listenerCount("exit"),
  };
}

describe("startCloudflareQuickTunnel", () => {
  test("resolves with the URL and removes listeners on success", async () => {
    const child = makeFakeChild();
    const pending = startCloudflareQuickTunnel(49390, 5_000, spawnStub(child));
    child.stderr.emit(
      "data",
      "noise… https://my-tunnel-123.trycloudflare.com ready\n",
    );
    const handle = await pending;
    expect(handle.provider).toBe("cloudflare");
    expect(handle.publicUrl).toBe("https://my-tunnel-123.trycloudflare.com");
    expect(listenerCounts(child)).toEqual({
      stdoutData: 0,
      stderrData: 0,
      error: 0,
      exit: 0,
    });
    // Post-settle output is ignored, not buffered.
    child.stderr.emit("data", "x".repeat(100_000));
    expect(listenerCounts(child).stderrData).toBe(0);

    await handle.stop();
    expect(child.killCalls).toEqual(["SIGTERM"]);
    // Second stop resolves immediately without another kill.
    await handle.stop();
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });

  test("stop() resolves immediately when the child already exited", async () => {
    const child = makeFakeChild();
    const pending = startCloudflareQuickTunnel(49390, 5_000, spawnStub(child));
    child.stdout.emit(
      "data",
      "https://early-exit-456.trycloudflare.com\n",
    );
    const handle = await pending;
    child.exitCode = 1; // exited on its own
    await handle.stop();
    expect(child.killCalls).toEqual([]);
  });

  test("stop() clears the SIGKILL timer when the child exits early", async () => {
    const child = makeFakeChild(true);
    const pending = startCloudflareQuickTunnel(49390, 5_000, spawnStub(child));
    child.stderr.emit("data", "https://timer-check.trycloudflare.com\n");
    const handle = await pending;
    await handle.stop();
    expect(child.killCalls).toEqual(["SIGTERM"]);
    expect(child.listenerCount("exit")).toBe(0);
  });

  test("rejects on timeout and cleans up listeners", async () => {
    const child = makeFakeChild(false); // never prints a URL, ignores SIGTERM
    await expect(
      startCloudflareQuickTunnel(49390, 50, spawnStub(child)),
    ).rejects.toThrow(/Timed out waiting for cloudflared/);
    expect(listenerCounts(child)).toEqual({
      stdoutData: 0,
      stderrData: 0,
      error: 0,
      exit: 0,
    });
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });

  test("rejects with install hint when the binary is missing", async () => {
    const child = makeFakeChild();
    const pending = startCloudflareQuickTunnel(49390, 5_000, spawnStub(child));
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    child.emit("error", err);
    await expect(pending).rejects.toThrow(/binary not found/);
    expect(listenerCounts(child)).toEqual({
      stdoutData: 0,
      stderrData: 0,
      error: 0,
      exit: 0,
    });
  });

  test("rejects when the child exits before printing a URL", async () => {
    const child = makeFakeChild();
    const pending = startCloudflareQuickTunnel(49390, 5_000, spawnStub(child));
    child.stderr.emit("data", "some startup log\n");
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow(/exited unexpectedly with code 1/);
    expect(listenerCounts(child)).toEqual({
      stdoutData: 0,
      stderrData: 0,
      error: 0,
      exit: 0,
    });
  });

  test("caps buffered logs and keeps error output bounded", async () => {
    const child = makeFakeChild();
    const pending = startCloudflareQuickTunnel(49390, 5_000, spawnStub(child));
    child.stderr.emit("data", "A".repeat(200_000));
    child.emit("exit", 1);
    const err = await pending.then(
      () => {
        throw new Error("should have rejected");
      },
      (e: Error) => e,
    );
    expect(err.message).toMatch(/exited unexpectedly/);
    expect(err.message.length).toBeLessThan(2_000);
    expect(listenerCounts(child)).toEqual({
      stdoutData: 0,
      stderrData: 0,
      error: 0,
      exit: 0,
    });
  });
});
