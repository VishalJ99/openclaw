import { expect, it } from "vitest";
import { prepareConversationPromptContext } from "./conversation-prompt-context.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { baseParams, createInboundTurn, createSessionTurn } from "./get-reply-run.test-support.js";

it("projects actual incoming conversation metadata while retaining group and exec instructions", async () => {
  const ctx = {
    ...createInboundTurn("Please inspect this.", "whatsapp", "group"),
    OriginatingChannel: "whatsapp",
    AccountId: "primary",
    GroupSystemPrompt: "Caller group policy: never send mail.",
  };
  const prepared = await prepareReplyRunContext(
    baseParams({
      ctx,
      sessionCtx: { ...ctx, ...createSessionTurn("Please inspect this.", "whatsapp", "group") },
      isNewSession: false,
      systemSent: true,
      sessionKey: "agent:default:whatsapp:group:synthetic",
      execOverrides: { security: "deny", ask: "always" },
    }),
  );
  expect(prepared.kind).toBe("ready");
  if (prepared.kind !== "ready") {
    throw new Error("Expected incoming run preparation");
  }
  const original = prepared.extraSystemPromptParts.join("\n\n");
  const projected = prepareConversationPromptContext(original, prepared.conversationPromptContext);
  expect(original).toContain('"schema": "openclaw.inbound_meta.v2"');
  expect(original).toContain("You are in a WhatsApp group chat.");
  expect(projected.context).toContain('"account_id": "primary"');
  expect(projected.context).toContain("sourceChatType=group");
  expect(projected.systemPrompt).not.toContain('"schema": "openclaw.inbound_meta.v2"');
  expect(projected.systemPrompt).toContain("Activation:");
  expect(projected.systemPrompt).toContain("Caller group policy: never send mail.");
  expect(projected.systemPrompt).toContain("security=deny ask=always");
});
