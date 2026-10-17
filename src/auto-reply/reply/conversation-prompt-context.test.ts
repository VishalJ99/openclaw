import { describe, expect, it } from "vitest";
import {
  buildConversationPromptContext,
  prepareConversationPromptContext,
} from "./conversation-prompt-context.js";

describe("producer-owned conversation prompt context", () => {
  const contribution = buildConversationPromptContext({
    metadataPrompt: "Generated message metadata.\n",
    metadataContext: '{"schema":"openclaw.inbound_meta.v2","account_id":"current"}',
    sourceContextByMode: {
      automatic: "Automatic conversation policy.",
      message_tool_only: "Private-final conversation policy.",
    },
    sourceFacts: "Current source conversation facts: sourceChatType=direct",
  });
  it.each(contribution.promptComponents)("moves only the exact owned component %s", (component) => {
    const extra = "### Message Context\nCaller security policy: do not send mail.";
    const projected = prepareConversationPromptContext(`${component}\n\n${extra}`, contribution);
    expect(projected.systemPrompt).toBe(extra);
    expect(projected.context).toContain('"account_id":"current"');
  });
  it("projects format-only contributions against raw offsets and trailing newlines", () => {
    const extra = "  Caller policy stays in system.  ";
    const format = "### Delivery Format\nGenerated format.\n";
    const descriptor = buildConversationPromptContext({
      metadataPrompt: format,
      metadataContext: 'Current delivery format: {"text_markup":"plain"}',
      promptOffset: extra.length + 2,
    });
    const projected = prepareConversationPromptContext(`${extra}\n\n${format}`, descriptor);
    expect(projected.systemPrompt.trim()).toBe(extra.trim());
    expect(projected.context).toContain('"text_markup":"plain"');
  });
  it.each([-1, 0.5, 1])(
    "keeps full instructions on an invalid or mismatching offset %s",
    (promptOffset) => {
      const prompt = contribution.promptComponents[0];
      const projected = prepareConversationPromptContext(prompt, { ...contribution, promptOffset });
      expect(projected).toEqual({ systemPrompt: prompt });
    },
  );
  it("keeps legacy heading lookalikes in system when producer provenance is unavailable", () => {
    const prompt = "### Message Context\nCaller-owned security instructions.";
    const projected = prepareConversationPromptContext(prompt);
    expect(projected.systemPrompt).toBe(prompt);
    expect(projected.context).toBeUndefined();
  });
  it("clears previous metadata only when the current system context is empty", () => {
    const projected = prepareConversationPromptContext("");
    expect(projected.context).toContain("Current inbound metadata: none");
    expect(projected.context).toContain("Current delivery format: none");
  });
});
