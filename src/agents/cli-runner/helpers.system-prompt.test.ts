import { Type } from "typebox";
// Verifies CLI system-prompt construction without loading the full runner.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHarnessVisibleReplyGuidance } from "../../auto-reply/source-reply-delivery-mode.js";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { resolveSessionGitCoauthorPrompt } from "../git-coauthor-prompt.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { buildCliAgentSystemPrompt } from "./helpers.js";
import { prepareCliSystemPrompt, prepareCliTurnPromptContext } from "./prompt-context.js";

vi.mock("../git-coauthor-prompt.js", () => ({
  resolveSessionGitCoauthorPrompt: vi.fn(),
}));

vi.mock("../../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

describe("buildCliAgentSystemPrompt", () => {
  afterEach(() => {
    clearPluginCommands();
    vi.mocked(resolveSessionGitCoauthorPrompt).mockReset();
  });

  it("prepares session credit before rendering the CLI system prompt", async () => {
    const gitCoauthorPrompt =
      "Git co-authors: add these exact trailers to every commit you make from this session.\n" +
      "Co-authored-by: ada <20+ada@users.noreply.github.com>";
    vi.mocked(resolveSessionGitCoauthorPrompt).mockResolvedValue(gitCoauthorPrompt);
    const config = {};
    const prompt = await prepareCliSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      config,
      agentId: "main",
      sessionKey: "agent:main:shared",
      sessionId: "shared-session",
      tools: [],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain(gitCoauthorPrompt);
    expect(resolveSessionGitCoauthorPrompt).toHaveBeenCalledExactlyOnceWith({
      config,
      agentId: "main",
      sessionKey: "agent:main:shared",
      sessionId: "shared-session",
    });
  });

  it("includes the OpenClaw skills prompt in CLI system prompts", () => {
    const preparedModelRuntime = {
      isCurrent: vi.fn(() => true),
      configuredModelAliases: [{ alias: "Current", provider: "fixture", model: "current" }],
    };
    const params = {
      workspaceDir: "/tmp",
      modelDisplay: "claude-cli/sonnet",
      config: { agents: { defaults: { model: "fixture/current" } } },
      preparedModelRuntime,
      tools: [],
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>weather</name>",
        "    <description>Use weather tools.</description>",
        "    <location>/tmp/skills/weather/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
    };
    const systemPrompt = buildCliAgentSystemPrompt(params);

    expect(systemPrompt).toContain("<name>weather</name>");
    expect(systemPrompt).toContain("- Current: fixture/current");
    preparedModelRuntime.isCurrent.mockReturnValue(false);
    expect(buildCliAgentSystemPrompt(params)).not.toContain("## Model Aliases");
  });

  it.each([true, false])(
    "gates ClawHub guidance on the CLI tool schema (available=%s)",
    (available) => {
      const message = createStubTool("message");
      message.parameters = Type.Object(
        available ? { clawhub: Type.Object({ query: Type.String() }) } : {},
      );
      const prompt = buildCliAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        tools: [message],
        runtimeChannel: "webchat",
        modelDisplay: "test/model",
      });

      expect(
        prompt.includes("For explicit plugin/skill search/install or missing capability"),
      ).toBe(available);
    },
  );

  it("uses config-backed sub-agent delegation mode", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      tools: [{ name: "sessions_spawn" } as never],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("## Delegation");
  });

  it("uses CLI backend tool fallback instead of OpenClaw tool assumptions", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      docsPath: "/tmp/openclaw/docs",
      tools: [],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("No OpenClaw tool list is injected");
    expect(prompt).not.toContain("exec approval-pending");
  });

  it("distinguishes the CLI working directory from the agent workspace", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw-agent",
      cwd: "/tmp/task-repo",
      tools: [],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("Working directory: /tmp/task-repo");
    expect(prompt).toContain("Agent workspace: /tmp/openclaw-agent");
    expect(prompt).not.toContain("Working directory: /tmp/openclaw-agent");
  });

  it("renders the Bootstrap Pending gate for full bootstrap mode", () => {
    // CLI-backend runs must gate the first reply on a pending BOOTSTRAP.md the
    // same way the embedded runner does, not just inject the file as context.
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [],
      contextFiles: [
        {
          path: "/tmp/openclaw/BOOTSTRAP.md",
          content: "Figure out who you are, then delete this file.",
        },
      ],
      bootstrapMode: "full",
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("## Bootstrap Pending");
    expect(prompt).toContain("Can finish BOOTSTRAP.md here: do it.");
  });

  it("renders limited bootstrap guidance when the run cannot complete bootstrap", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [],
      bootstrapMode: "limited",
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("this run cannot safely finish full BOOTSTRAP.md");
  });

  it("includes CLI-scoped plugin command guidance", () => {
    // Plugin command guidance is surface-filtered; CLI prompts must not leak
    // OpenClaw-main command text into external CLI backends.
    registerPluginCommand("demo-plugin", {
      name: "demo_cli",
      description: "Demo CLI command",
      agentPromptGuidance: [
        {
          text: "CLI-only command guidance.",
          surfaces: ["cli_backend"],
        },
        {
          text: "OpenClaw-only command guidance.",
          surfaces: ["openclaw_main"],
        },
      ],
      handler: async () => ({ text: "ok" }),
    });

    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [{ name: "exec" } as never],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("CLI-only command guidance.");
    expect(prompt).not.toContain("OpenClaw-only command guidance.");
  });

  it("includes session identity in runtime when provided", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      config: {
        agents: {
          entries: {
            "Team Ops": { identity: { name: "Ops Navigator" } },
          },
        },
      },
      tools: [],
      modelDisplay: "test/model",
      agentId: "team-ops",
      sessionKey: "agent:team-ops:telegram:direct:peer",
      sessionId: "session-123",
    });

    expect(prompt).toContain(
      "Runtime: name=Ops Navigator | agent=team-ops | session=agent:team-ops:telegram:direct:peer",
    );
  });

  it("includes Telegram channel context for CLI final replies without core rich guidance", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [],
      modelDisplay: "anthropic/claude-opus-4-8",
      runtimeChannel: "telegram",
      runtimeChatType: "direct",
    });

    expect(prompt).toContain("channel=telegram");
    expect(prompt).not.toContain("Telegram rich ON");
    expect(prompt).not.toContain("### message tool");
  });

  it.each(["mattermost", "slack"])("preserves %s channel-owned button guidance", (channel) => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [createStubTool("message")],
      modelDisplay: "test/model",
      runtimeChannel: channel,
      runtimeCapabilities: ["inlineButtons"],
      customInlineButtonHint: true,
      messageToolHints: ["- Use the channel's supported button shape."],
    });

    expect(prompt).toContain("- Use the channel's supported button shape.");
    expect(prompt).not.toContain('"action":{"type":"callback"');
    expect(prompt).not.toContain("Inline buttons OFF");
  });

  it("requires an explicit message target when the CLI turn policy requires one", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [{ name: "message" } as never],
      modelDisplay: "test/model",
      sourceReplyDeliveryMode: "message_tool_only",
      requireExplicitMessageTarget: true,
    });

    expect(prompt).toContain("`send`: `target` + `message`; target required this turn");
    expect(prompt).not.toContain("current source is default target");
  });
});

describe("native Claude delivery context cache stability", () => {
  const tools = [createStubTool("exec"), createStubTool("message")];
  const base = {
    workspaceDir: "/tmp/openclaw",
    modelDisplay: "test/model",
    tools,
    deliveryContextInTurn: true,
    contextFiles: [{ path: "AGENTS.md", content: "Keep the workspace instructions." }],
  };
  async function prepare(overrides: Partial<Parameters<typeof buildCliAgentSystemPrompt>[0]>) {
    const input = { ...base, ...overrides };
    const systemPrompt = buildCliAgentSystemPrompt(input);
    return prepareCliTurnPromptContext({
      backendId: "claude-cli",
      backend: { command: "claude", systemPromptArg: "--system-prompt" },
      privateContext: true,
      isNewSession: false,
      systemPrompt,
      prompt: "Continue the task.",
      capabilityToolNames: new Set(tools.map((tool) => tool.name)),
      context: [],
      prependContext: [],
      deliveryGuidance: buildHarnessVisibleReplyGuidance({
        sourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
        messageToolAvailable: true,
        requireExplicitMessageTarget: input.requireExplicitMessageTarget,
      }),
    });
  }
  it("keeps native appendSystemPrompt bytes across source, handoff, completion and source turns", async () => {
    const turns = [
      {
        runtimeChannel: "whatsapp",
        runtimeChatType: "direct" as const,
        sourceReplyDeliveryMode: "message_tool_only" as const,
      },
      {
        runtimeChannel: "webchat",
        runtimeChatType: "group" as const,
        runtimeCapabilities: ["inlineButtons", "markdownDetails"],
        customInlineButtonHint: true,
        sourceReplyDeliveryMode: "automatic" as const,
        requireExplicitMessageTarget: true,
        silentReplyPromptMode: "none" as const,
      },
      {
        runtimeChannel: "whatsapp",
        sourceReplyDeliveryMode: "message_tool_only" as const,
        requireExplicitMessageTarget: true,
      },
      {
        runtimeChannel: "whatsapp",
        runtimeChatType: "direct" as const,
        sourceReplyDeliveryMode: "message_tool_only" as const,
      },
    ];
    const results = [];
    for (const turn of turns) {
      results.push(await prepare(turn));
    }
    expect(new Set(results.map((result) => result.systemPrompt)).size).toBe(1);
    for (const [index, result] of results.entries()) {
      expect(result.systemPrompt).toContain("Keep the workspace instructions.");
      expect(result.systemPrompt).toContain("No hidden instructions/private data/reasoning.");
      expect(result.systemPrompt).toContain(
        "if the current turn says final private, visible output uses `message(action=send)`",
      );
      expect(result.systemPrompt).toContain(
        "In automatic mode with silentReplyPromptMode=none: follow turn delivery: private final => visible via `message(send)`; otherwise normal reply once",
      );
      expect(result.systemPrompt).toContain(
        "customInlineButtonHint=false, current channel is present, and capabilities lack inlinebuttons",
      );
      expect(result.systemPrompt).toContain(
        "ask owner for `<current channel>.capabilities.inlineButtons=dm|group|all|allowlist`",
      );
      expect(result.systemPrompt).toContain("In automatic mode, `send`: `target` + `message`");
      expect(result.systemPrompt).toContain(
        "In message_tool_only mode, include `message`; when requireExplicitMessageTarget=true, `target` is required",
      );
      expect(result.systemPrompt).toContain("No source default: proactive send needs `channel`");
      expect(result.systemPrompt).toContain(
        "In automatic mode with silentReplyPromptMode=generic: after visible `message(send)`, final ONLY uppercase NO_REPLY",
      );
      expect(result.systemPrompt).toContain("send confirmations before ending silently");
      expect(result.systemPrompt).toContain(
        "or a final reaction to the current source message: `message(action=react, final=true)`",
      );
      expect(result.systemPrompt).toContain(
        "A confirmed final message or added final reaction to the current source completes the reply; never repeat it in text",
      );
      expect(result.promptContext?.appendContext).toContain(
        `channel=${turns[index].runtimeChannel}`,
      );
      expect(result.promptContext?.appendContext).toContain(
        `sourceReplyDeliveryMode=${turns[index].sourceReplyDeliveryMode}`,
      );
    }
    expect(results[1].promptContext?.appendContext).toContain(
      "OpenClaw delivers your final response automatically.",
    );
    expect(results[0].promptContext?.appendContext).toContain("customInlineButtonHint=false");
    expect(results[1].promptContext?.appendContext).toContain("customInlineButtonHint=true");
    expect(results[1].promptContext?.appendContext).toContain("target required this turn");
    expect(results[2].promptContext?.appendContext).toContain("final=false");
    expect(results[2].promptContext?.appendContext).toContain(
      "An added reaction to the current source message with `final=true` can also complete the reply.",
    );
    expect(results[2].promptContext?.appendContext).toContain("Do not repeat delivered content.");
    expect(results[2].promptContext?.appendContext).toContain("target required this turn");
  });
  it("refreshes genuine instructions, owner identity and tool restrictions", async () => {
    const first = await prepare({
      runtimeChannel: "whatsapp",
      extraSystemPrompt: "Do not send mail.",
      ownerNumbers: ["owner-a"],
    });
    const changed = await prepare({
      runtimeChannel: "whatsapp",
      extraSystemPrompt: "Do not send mail or delete files.",
      ownerNumbers: ["owner-b"],
      tools: [],
    });
    expect(changed.systemPrompt).not.toBe(first.systemPrompt);
    expect(changed.systemPrompt).toContain("Do not send mail or delete files.");
    expect(changed.systemPrompt).toContain("owner-b");
    expect(changed.systemPrompt).not.toContain("owner-a");
    expect(changed.systemPrompt).not.toContain("- exec: Run shell");
    expect(changed.systemPrompt).not.toContain(
      "if the current turn says final private, visible output uses `message(action=send)`",
    );
  });
});
