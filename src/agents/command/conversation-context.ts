import { buildConversationPromptContext } from "../../auto-reply/reply/conversation-prompt-context.js";
import {
  buildGroupIntro,
  buildSourceConversationContext,
  buildSourceConversationFacts,
  defaultGroupActivation,
  resolveGroupRequireMention,
} from "../../auto-reply/reply/groups.js";
import { buildInboundMetaPromptContext } from "../../auto-reply/reply/inbound-meta.js";
import { prepareReplyConversation } from "../../auto-reply/reply/prompt-session-context.js";
import { resolveSessionStableReplyMode } from "../../auto-reply/reply/session-stable-reply-mode.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildDeliveryFormatPromptContext } from "../../infra/outbound/delivery-format-prompt.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { isSyntheticSourceReplyTurn } from "../reply-completion.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

/** Reuse conversation guidance without borrowing the originating sender's authority. */
export async function prepareCommandConversationContext(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  runContext: AgentRunContext;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  sessionAgentId: string;
}) {
  const { cfg, opts, runContext, sessionEntry, sessionKey, sessionAgentId } = params;
  const deliveryFormat =
    (opts.deliver === true || opts.sourceReplyDeliveryMode === "message_tool_only") &&
    buildDeliveryFormatPromptContext({
      cfg,
      channel: opts.replyChannel ?? runContext.messageChannel,
      accountId: opts.replyAccountId ?? runContext.accountId,
      agentId: sessionAgentId,
      allowBootstrap: true,
    });
  let conversationPrompt: string | undefined;
  let conversationPromptContext = opts.conversationPromptContext;
  if (
    sessionEntry &&
    !isSubagentSessionKey(sessionKey) &&
    !isCronSessionKey(sessionKey) &&
    isSyntheticSourceReplyTurn(opts)
  ) {
    const conversation = prepareReplyConversation({
      sessionEntry,
      ctx: {
        InternalTurnSource: "event",
        Provider: runContext.messageChannel,
        Surface: runContext.messageChannel,
        ChatType: sessionEntry.delivery?.kind === "internal" ? sessionEntry.chatType : undefined,
        OriginatingChannel: runContext.messageChannel,
        OriginatingTo: runContext.currentChannelId,
        AccountId: runContext.accountId,
        MessageThreadId: runContext.currentThreadTs,
      },
    });
    const ctx = { ...conversation.fields, CommandAuthorized: false };
    const shared = ctx.ChatType === "group" || ctx.ChatType === "channel";
    const sourceContextParams = {
      sessionCtx: ctx,
      sourceReplyDeliveryMode: await resolveSessionStableReplyMode({
        cfg,
        ctx,
        sessionEntry,
        sessionAgentId,
        sessionKey,
      }),
    };
    const sourceContext = buildSourceConversationContext(sourceContextParams);
    if (sourceContext) {
      // Metadata describes the conversation; delivery preflight owns formatting.
      const metadata = buildInboundMetaPromptContext(ctx, cfg, { includeFormattingHints: false });
      const metadataPrompt = deliveryFormat
        ? `${metadata.systemPrompt}\n${deliveryFormat.systemPrompt}`
        : metadata.systemPrompt;
      conversationPromptContext = buildConversationPromptContext({
        metadataPrompt,
        metadataContext: `Current inbound metadata:\n${metadata.metadataContext}\nCurrent delivery format:\n${deliveryFormat ? deliveryFormat.context : "none"}`,
        sourceContextByMode: {
          automatic: buildSourceConversationContext({
            ...sourceContextParams,
            sourceReplyDeliveryMode: "automatic",
          }),
          message_tool_only: buildSourceConversationContext({
            ...sourceContextParams,
            sourceReplyDeliveryMode: "message_tool_only",
          }),
        },
        sourceFacts: buildSourceConversationFacts(sourceContextParams),
      });
      conversationPrompt = [
        metadataPrompt,
        sourceContext,
        shared &&
          buildGroupIntro({
            activation: conversation.activation,
            defaultActivation: defaultGroupActivation(
              await resolveGroupRequireMention({ cfg, group: conversation.group }),
            ),
          }),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  }
  if (!conversationPrompt && deliveryFormat) {
    conversationPromptContext = buildConversationPromptContext({
      metadataPrompt: deliveryFormat.systemPrompt,
      metadataContext: [
        !opts.extraSystemPrompt?.trim() && "Current inbound metadata: none.",
        `Current delivery format:\n${deliveryFormat.context}`,
      ]
        .filter(Boolean)
        .join("\n"),
      promptOffset: opts.extraSystemPrompt ? opts.extraSystemPrompt.length + 2 : 0,
    });
  }
  return conversationPrompt || deliveryFormat
    ? {
        ...opts,
        conversationPromptContext,
        extraSystemPrompt: [
          conversationPrompt,
          opts.extraSystemPrompt,
          !conversationPrompt && deliveryFormat && deliveryFormat.systemPrompt,
        ]
          .filter(Boolean)
          .join("\n\n"),
        ...(conversationPrompt ? { silentReplyPromptMode: "none" as const } : {}),
      }
    : opts;
}
