import { realpath } from "node:fs/promises";
import path from "node:path";
import { isCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import type { CliHistoryWriter } from "../config/sessions/cli-history-boundary.js";
import { runWithCliHistoryWriter } from "../config/sessions/cli-history-boundary.js";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.types.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptWriterFence,
  withOwnedSessionTranscriptWriterFence,
} from "../config/sessions/transcript-write-context.js";
import type { resolveBootstrapContextForRun } from "./bootstrap-files.js";

const SNAPSHOT_TYPE = "openclaw:workspace-context:v1";
// Keep the existing payload shape readable; rendered fields are legacy derived data.
// Every harness renders the saved raw files using its current budgets and carriers.
const ContextSchema = z.object({
  bootstrapFiles: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      content: z.string().optional(),
      missing: z.boolean().default(false),
      personalUser: z.literal(true).optional(),
    }),
  ),
  contextFiles: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
      personalUser: z.literal(true).optional(),
    }),
  ),
});
type BootstrapContext = Awaited<ReturnType<typeof resolveBootstrapContextForRun>>;

/** SQLite owns the snapshot; process caches and native session handles are disposable. */
export async function prepareBootstrapSnapshot(params: {
  writer?: CliHistoryWriter;
  target?: SessionTranscriptRuntimeTarget;
  expectedWriterRunId?: string;
  workspaceDir: string;
  executionWorkspaceDir?: string;
  profileId?: string;
  audience?: string;
  contextMode?: "full" | "lightweight";
  assertCurrent: () => void;
  load: () => Promise<BootstrapContext>;
  render: (files: BootstrapContext["bootstrapFiles"]) => BootstrapContext["contextFiles"];
}) {
  const sourceTarget = params.writer?.target ?? params.target;
  if (!sourceTarget) {
    throw new Error("Workspace snapshot requires an admitted session target.");
  }
  const fence = params.writer
    ? undefined
    : getOwnedSessionTranscriptWriterFence({ sessionTarget: sourceTarget });
  if (!params.writer && (!fence || fence.expectedWriterRunId !== params.expectedWriterRunId)) {
    throw new Error("Workspace snapshot requires the current host transcript writer fence.");
  }
  const target = withOwnedSessionTranscriptWriterFence(sourceTarget);
  const assertTranscript = captureOwnedTranscriptWriteAssertion(target);
  const workspaceDir = await realpath(params.workspaceDir);
  const executionWorkspaceDir = params.executionWorkspaceDir
    ? await realpath(params.executionWorkspaceDir)
    : workspaceDir;
  const scope = JSON.stringify([
    workspaceDir,
    params.profileId ?? null,
    params.audience ?? null,
    params.contextMode ?? "full",
    ...(executionWorkspaceDir !== workspaceDir ? [executionWorkspaceDir] : []),
  ]);
  const assertCurrent = () => {
    params.writer?.assertCurrent();
    assertTranscript();
    params.assertCurrent();
  };
  const load = async (
    refresh: boolean,
    options?: { createIfMissing?: boolean },
  ): Promise<BootstrapContext> => {
    assertCurrent();
    await params.writer?.assertReadable();
    // The existing manager owns complete active-branch reads and account-aware
    // async metadata appends, including actor-backed sessions and publication.
    const [{ SessionManager }, { withSessionManagerWriteAssertion }] = await Promise.all([
      import("./sessions/session-manager.js"),
      import("./sessions/session-manager-write-admission.js"),
    ]);
    assertCurrent();
    const manager = await SessionManager.openAsync(target, workspaceDir);
    assertCurrent();
    if (!refresh) {
      for (const entry of manager.getBranch().toReversed()) {
        if (!isRecord(entry)) {
          continue;
        }
        // Successful host compaction supersedes file bytes before its first continuation.
        if (
          entry.type === "compaction" ||
          (entry.type === "message" &&
            isRecord(entry.message) &&
            isCompactionReplayCheckpoint(entry.message.providerReplay))
        ) {
          break;
        }
        if (entry.type === "reset") {
          break;
        }
        if (
          entry.type === "custom" &&
          entry.customType === SNAPSHOT_TYPE &&
          isRecord(entry.data) &&
          entry.data.scope === scope
        ) {
          const saved = ContextSchema.parse(entry.data.context);
          assertCurrent();
          return { ...saved, contextFiles: params.render(saved.bootstrapFiles) };
        }
      }
    }
    if (options?.createIfMissing === false) {
      throw new Error(
        "Workspace context snapshot is missing; run a regular turn before native compaction.",
      );
    }
    const loaded = await params.load();
    const context: BootstrapContext = {
      contextFiles: [],
      bootstrapFiles: loaded.bootstrapFiles.map((file) => ({
        name: normalizeOptionalString(file.name) ?? path.basename(file.path),
        path: file.path,
        content: file.content,
        missing: file.missing,
        personalUser: file.personalUser,
      })),
    };
    assertCurrent();
    await runWithCliHistoryWriter(params.writer, () =>
      withSessionManagerWriteAssertion(manager, assertCurrent, () =>
        manager.appendCustomEntryAsync(SNAPSHOT_TYPE, { scope, context }),
      ),
    );
    assertCurrent();
    return { ...context, contextFiles: params.render(context.bootstrapFiles) };
  };
  return { load, scope };
}
