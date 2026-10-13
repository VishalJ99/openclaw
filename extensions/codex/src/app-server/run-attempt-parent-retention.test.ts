import path from "node:path";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createNativeRunParams as createParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.test-support.js";
import { createInferenceReadyClientHarness, waitForHarnessRequest } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

setupRunAttemptTestHooks();

describe("Codex interrupted parent subscription", () => {
  beforeEach(() => resetSharedCodexAppServerClientForTests());
  afterEach(() => resetSharedCodexAppServerClientForTests());

  it("reuses a cancelled parent's protected subscription without stealing an active claim", async () => {
    const sessionFile = path.join(tempDir, "cancelled-parent.jsonl");
    const workspaceDir = path.join(tempDir, "cancelled-parent-workspace");
    const sessionKey = "agent:main:cancelled-parent";
    await seedRunSessionOwnerForTest("session-1", sessionKey);
    const harness = createInferenceReadyClientHarness();
    const startClient = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const abort = new AbortController();
    const params = createParams(sessionFile, workspaceDir, sessionKey);
    params.provider = "openai";
    params.disableTools = false;
    params.abortSignal = abort.signal;
    params.hostCapabilities = {
      ...params.hostCapabilities,
      assertActive: () => abort.signal.throwIfAborted(),
    };
    let run = runCodexAppServerAttempt(params, { bindingStore: testCodexAppServerBindingStore });
    const initialize = await waitForHarnessRequest(harness, "initialize");
    harness.send({
      id: initialize.id,
      result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
    });
    const requirements = await waitForHarnessRequest(harness, "configRequirements/read");
    harness.send({ id: requirements.id, result: { requirements: null } });
    const start = await waitForHarnessRequest(harness, "thread/start");
    harness.send({
      id: start.id,
      result: threadStartResult("thread-parent", { cwd: workspaceDir }),
    });
    const turn = await waitForHarnessRequest(harness, "turn/start");
    harness.send({ id: turn.id, result: turnStartResult("turn-parent") });
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-parent",
        turn: { id: "turn-parent", status: "completed", items: [] },
      },
    });
    await run;
    params.runId = "cancel-warm-parent";
    const cancelledRequestStart = harness.writes.length;
    run = runCodexAppServerAttempt(params, { bindingStore: testCodexAppServerBindingStore });
    const cancelledRequirements = await waitForHarnessRequest(
      harness,
      "configRequirements/read",
      cancelledRequestStart,
    );
    harness.send({ id: cancelledRequirements.id, result: { requirements: null } });
    const cancelledTurn = await waitForHarnessRequest(harness, "turn/start", cancelledRequestStart);
    harness.send({ id: cancelledTurn.id, result: turnStartResult("turn-cancelled") });
    await yieldEventLoop();
    // The native child monitor owns this protection until child completion delivery.
    const releaseChild = protectCodexAppServerLiveThread(harness.client, "thread-parent");
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-parent")).toBe(true);
    abort.abort("foreground caller cancelled");
    const interrupt = await waitForHarnessRequest(harness, "turn/interrupt");
    expect(interrupt.params).toEqual({ threadId: "thread-parent", turnId: "turn-cancelled" });
    harness.send({ id: interrupt.id, result: {} });
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-parent",
        turn: { id: "turn-cancelled", status: "interrupted", items: [] },
      },
    });
    const terminals = await waitForHarnessRequest(
      harness,
      "thread/backgroundTerminals/list",
      cancelledRequestStart,
    );
    harness.send({ id: terminals.id, result: { data: [], nextCursor: null } });
    expect(readAttemptTerminal(await run)).toMatchObject({ aborted: true });
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-parent")).toBe(false);
    expect(harness.writes.map((write) => JSON.parse(write).method)).not.toContain(
      "thread/unsubscribe",
    );

    const next = createParams(sessionFile, workspaceDir, sessionKey);
    next.provider = "openai";
    next.disableTools = false;
    next.runId = "parent-continuation";
    const requestStart = harness.writes.length;
    const continuation = runCodexAppServerAttempt(next, {
      bindingStore: testCodexAppServerBindingStore,
    });
    const nextRequirements = await waitForHarnessRequest(
      harness,
      "configRequirements/read",
      requestStart,
    );
    harness.send({ id: nextRequirements.id, result: { requirements: null } });
    const nextTurn = await waitForHarnessRequest(harness, "turn/start", requestStart);
    expect(nextTurn.params).toMatchObject({ threadId: "thread-parent" });
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-parent")).toBe(true);
    releaseChild();
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-parent")).toBe(true);
    harness.send({ id: nextTurn.id, result: turnStartResult("turn-continuation") });
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-parent",
        turn: { id: "turn-continuation", status: "completed", items: [] },
      },
    });
    expect(readAttemptTerminal(await continuation)).toMatchObject({
      aborted: false,
      promptError: null,
    });
    expect(startClient).toHaveBeenCalledOnce();
    expect(
      harness.writes.slice(requestStart).map((write) => JSON.parse(write).method),
    ).not.toContain("thread/resume");
  });
});
