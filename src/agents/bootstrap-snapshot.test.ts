import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { CliHistoryWriter } from "../config/sessions/cli-history-boundary.js";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { clearInternalHooks, registerInternalHook } from "../hooks/internal-hooks.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { prepareBootstrapSnapshot } from "./bootstrap-snapshot.js";
import { buildBootstrapContextForFiles } from "./embedded-agent-helpers/bootstrap.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const stateDir of dirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
    clearRuntimeConfigSnapshot();
    clearInternalHooks();
  });
});

it("recovers saved bytes beyond the recent-event window and refreshes only at a boundary", async () => {
  const workspaceDir = dirs.make("openclaw-workspace-snapshot-");
  setRuntimeConfigSnapshot({});
  const target = {
    agentId: "main",
    sessionId: "snapshot",
    sessionKey: "agent:main:snapshot",
    storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1,
    activeWriterRunId: "snapshot-run",
  });
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("revoked");
    }
  };
  const writer: CliHistoryWriter = {
    target,
    runId: "snapshot-run",
    authFingerprint: "a".repeat(64),
    assertCurrent,
    assertReadable: assertCurrent,
  };
  await writeFile(path.join(workspaceDir, "AGENTS.md"), "FIRST");
  registerInternalHook("agent:bootstrap", (event) => {
    if (Array.isArray(event.context.bootstrapFiles)) {
      event.context.bootstrapFiles.push(
        {
          name: "EXTRA.md",
          path: path.join(workspaceDir, "EXTRA.md"),
          content: "HOOK_EXTRA",
          missing: false,
        },
        { path: path.join(workspaceDir, "PATH_ONLY.md"), content: "HOOK_PATH_ONLY" },
      );
    }
  });
  const load = vi.fn(() =>
    resolveBootstrapContextForRun({ workspaceDir, sessionKey: target.sessionKey }),
  );
  const owner = () =>
    prepareBootstrapSnapshot({
      writer,
      workspaceDir,
      load,
      assertCurrent,
      render: (files) => buildBootstrapContextForFiles(files, {}),
    });
  expect((await (await owner()).load(false)).contextFiles[0]?.content).toBe("FIRST");
  // No model messages: storage-only notes may grow beyond continuation marker bounds.
  for (let index = 0; index < 501; index++) {
    await appendTranscriptEvent(target, {
      type: "custom",
      id: `note-${index}`,
      customType: "note",
      data: {},
    });
  }
  await writeFile(path.join(workspaceDir, "AGENTS.md"), "SECOND");
  expect((await (await owner()).load(false)).contextFiles[0]?.content).toBe("FIRST");
  expect(load).toHaveBeenCalledTimes(1);
  const recovered = await (await owner()).load(false);
  expect(recovered.contextFiles).toEqual(
    expect.arrayContaining([
      { path: path.join(workspaceDir, "EXTRA.md"), content: "HOOK_EXTRA" },
      { path: path.join(workspaceDir, "PATH_ONLY.md"), content: "HOOK_PATH_ONLY" },
    ]),
  );
  expect(recovered.bootstrapFiles.find((file) => file.name === "PATH_ONLY.md")?.missing).toBe(
    false,
  );
  expect((await (await owner()).load(true)).contextFiles[0]?.content).toBe("SECOND");
  expect((await (await owner()).load(false)).contextFiles[0]?.content).toBe("SECOND");
  current = false;
  await expect((await owner()).load(true)).rejects.toThrow("revoked");
  expect(load).toHaveBeenCalledTimes(2);
});
