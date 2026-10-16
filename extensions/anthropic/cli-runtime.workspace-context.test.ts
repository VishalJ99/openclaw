import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_PROTOCOL_FIXTURE, collect, resultDetail } from "./cli-runtime.test-support.js";

const roots: string[] = [];
const handles = new Set<CliBackendLiveSessionHandle>();
afterEach(async () => {
  for (const handle of handles) {
    handle.close("restart");
    await handle.waitForExit();
  }
  handles.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createContext(
  scenario: string,
  overrides: Partial<CliBackendExecuteContext>,
): Promise<CliBackendExecuteContext> {
  // A real subprocess speaks the managed protocol; no model or user state is used.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-hook-")));
  roots.push(root);
  const fixture = path.join(root, "claude.mjs");
  await writeFile(fixture, CLAUDE_PROTOCOL_FIXTURE);
  let current: CliBackendLiveSessionHandle | undefined;
  return {
    command: process.execPath,
    args: [fixture],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_FIXTURE_SCENARIO: scenario,
    },
    prompt: "synthetic input",
    systemPrompt: "stable operator policy",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    timeoutMs: 10_000,
    abortSignal: AbortSignal.timeout(10_000),
    liveSession: {
      fingerprint: "workspace-hook-policy",
      current: () => current,
      activate() {},
      register(handle) {
        current = handle;
        handles.add(handle);
      },
      remove(handle) {
        if (current === handle) {
          current = undefined;
        }
      },
      async restart() {
        current?.close("restart");
        await current?.waitForExit();
      },
    },
    requestToolPermission: async () => ({ behavior: "deny", message: "No tools expected." }),
    requestUserInput: async () => ({ status: "cancelled", message: "No questions expected." }),
    ...overrides,
  };
}

describe("Claude workspace lifecycle context", () => {
  it("injects workspace context once per process and awaits compact context before continuation", async () => {
    const workspaceContext = vi.fn(async (source: "startup" | "resume" | "compact") =>
      source === "compact" ? "FRESH_WORKSPACE" : "SAVED_WORKSPACE",
    );
    const context = await createContext("workspace-context", { workspaceContext });
    const first = resultDetail(await collect(context));
    expect(first.privateContext).toBe("SAVED_WORKSPACE");
    const second = resultDetail(await collect({ ...context, useResume: true }));
    expect(second.privateContext).toBeUndefined();
    expect(second.compactContext).toBe("FRESH_WORKSPACE");
    expect(workspaceContext.mock.calls).toEqual([["startup"], ["compact"]]);
  });

  it("does not replay precompact files when native rewrites the same submitted input", async () => {
    const context = await createContext("workspace-context-rerun", {
      workspaceContext: async (source) =>
        source === "compact" ? "FRESH_WORKSPACE" : "SAVED_WORKSPACE",
    });
    const output = resultDetail(await collect(context));
    expect(output.privateContext).toBe("SAVED_WORKSPACE");
    expect(output.compactContext).toBe("FRESH_WORKSPACE");
    expect(output.compactRerunContext).toBeUndefined();
  });

  it("aborts the native process when required workspace persistence fails", async () => {
    const context = await createContext("workspace-context", {
      workspaceContext: async () => {
        throw new Error("snapshot write failed");
      },
    });
    await expect(collect(context)).rejects.toThrow("snapshot write failed");
    expect(context.liveSession?.current()).toBeUndefined();
  });
});
