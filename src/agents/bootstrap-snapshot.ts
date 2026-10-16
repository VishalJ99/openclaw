import { realpath } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import type { CliHistoryWriter } from "../config/sessions/cli-history-boundary.js";
import { runWithCliHistoryWriter } from "../config/sessions/cli-history-boundary.js";
import type { resolveBootstrapContextForRun } from "./bootstrap-files.js";

const SNAPSHOT_TYPE = "openclaw:workspace-context:v1";
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
  writer: CliHistoryWriter;
  workspaceDir: string;
  profileId?: string;
  audience?: string;
  contextMode?: "full" | "lightweight";
  assertCurrent: () => void;
  load: () => Promise<BootstrapContext>;
}) {
  const workspaceDir = await realpath(params.workspaceDir);
  const scope = JSON.stringify([
    workspaceDir,
    params.profileId ?? null,
    params.audience ?? null,
    params.contextMode ?? "full",
  ]);
  const assertCurrent = () => {
    params.writer.assertCurrent();
    params.assertCurrent();
  };
  const load = async (
    refresh: boolean,
    options?: { createIfMissing?: boolean },
  ): Promise<BootstrapContext> => {
    assertCurrent();
    await params.writer.assertReadable();
    // The existing manager owns complete active-branch reads and account-aware
    // async metadata appends, including actor-backed sessions and publication.
    const [{ SessionManager }, { withSessionManagerWriteAssertion }] = await Promise.all([
      import("./sessions/session-manager.js"),
      import("./sessions/session-manager-write-admission.js"),
    ]);
    assertCurrent();
    const manager = await SessionManager.openAsync(params.writer.target, workspaceDir);
    assertCurrent();
    if (!refresh) {
      for (const entry of manager.getBranch().toReversed()) {
        if (!isRecord(entry)) {
          continue;
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
          return saved;
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
      ...loaded,
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
    return context;
  };
  return { load, scope };
}
