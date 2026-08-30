import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { expect, test } from "bun:test";

import { DEFAULT_CONFIG, type SandboxConfig } from "../config.ts";
import {
  SandboxCoordinator,
  type SandboxRuntimeAdapter,
} from "../coordinator.ts";
import {
  createHostToolVisibility,
  registerSandboxExtension,
  sandboxToolBlockReason,
} from "../index.ts";
import type { SessionAllowances } from "../runtime.ts";

class FakeRuntime implements SandboxRuntimeAdapter {
  initializations = 0;
  resets = 0;

  async initialize(
    _config: SandboxConfig,
    _cwd: string,
    _allowances: SessionAllowances,
    _protectedWritePaths: string[],
  ): Promise<void> {
    this.initializations += 1;
  }

  async reset(): Promise<void> {
    this.resets += 1;
  }
}

interface ExtensionHarness {
  api: ExtensionAPI;
  activeTools(): string[];
  handler(name: string): (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
  command(name: string): (args: string, ctx: ExtensionContext) => Promise<void>;
}

function extensionHarness(): ExtensionHarness {
  let active = ["bash", "grep", "glob", "custom"];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  class FakeBashTool {
    constructor(_options: unknown) {}
  }
  const Type = {
    String: () => ({ type: "string" }),
    Number: () => ({ type: "number" }),
    Boolean: () => ({ type: "boolean" }),
    Record: () => ({ type: "object" }),
    Optional: (value: unknown) => value,
    Object: (properties: unknown) => ({ type: "object", properties }),
  };
  const api = {
    typebox: { Type },
    pi: { BashTool: FakeBashTool, settings: {} },
    registerTool() {},
    registerFlag() {},
    getFlag: () => false,
    registerShortcut() {},
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => commands.set(name, command.handler),
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown,
    ) => handlers.set(event, handler),
    getActiveTools: () => [...active],
    setActiveTools: async (tools: string[]) => { active = [...tools]; },
    events: { emit() {} },
  } as unknown as ExtensionAPI;

  return {
    api,
    activeTools: () => [...active],
    handler(name) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing handler: ${name}`);
      return handler;
    },
    command(name) {
      const handler = commands.get(name);
      if (!handler) throw new Error(`Missing command: ${name}`);
      return handler;
    },
  };
}

function context(id: string, notifications: string[]): ExtensionContext {
  return {
    cwd: `/workspace/${id}`,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id },
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus() {},
      confirm: async () => true,
    },
  } as unknown as ExtensionContext;
}

test("hides OMP tools that bypass the sandbox and restores only removed tools", async () => {
  let active = [
    "read",
    "bash",
    "grep",
    "glob",
    "lsp",
    "python",
    "notebook",
    "inspect_image",
    "eval",
    "custom",
  ];
  const visibility = createHostToolVisibility({
    getActiveTools: () => [...active],
    setActiveTools: async (tools) => { active = [...tools]; },
  });

  await visibility.hide();
  expect(active).toEqual(["read", "bash", "custom"]);

  active.push("grep");
  await visibility.hide();
  expect(active).toEqual(["read", "bash", "custom"]);

  active = ["read", "bash", "custom-after-enable"];
  await visibility.restore();
  expect(active).toEqual([
    "read",
    "bash",
    "custom-after-enable",
    "grep",
    "glob",
    "lsp",
    "python",
    "notebook",
    "inspect_image",
    "eval",
  ]);
});

test("tool-call backstop covers every hidden OMP tool", () => {
  const hidden = ["grep", "glob", "lsp", "python", "notebook", "inspect_image", "eval"];
  const tools = ["bash", "read", "write", "edit", ...hidden, "custom"];
  const unavailable = "Sandbox unavailable; command blocked";
  const readyBlocked = tools.filter((tool) => sandboxToolBlockReason(tool, true, unavailable));
  const failedBlocked = tools.filter((tool) => sandboxToolBlockReason(tool, false, unavailable));

  expect(readyBlocked).toEqual(hidden);
  expect(failedBlocked).toEqual(["bash", ...hidden]);
  expect(sandboxToolBlockReason("custom", true, unavailable)).toBeUndefined();
});

test("blocks eval tool execution while sandboxing is active", async () => {
  const coordinator = new SandboxCoordinator(
    "/root",
    new FakeRuntime(),
    async () => ({ ...DEFAULT_CONFIG, enabled: true }),
  );
  const harness = extensionHarness();
  const session = registerSandboxExtension(harness.api, coordinator);
  const notifications: string[] = [];
  const ctx = context("eval-tool", notifications);

  await harness.handler("session_start")({ type: "session_start" }, ctx);
  const result = await harness.handler("tool_call")(
    { toolName: "eval", input: { language: "py", code: "open('/home/royce/.bashrc').read()" } },
    ctx,
  );

  expect(session.ready).toBe(true);
  expect(result).toEqual({
    block: true,
    reason: "The eval tool bypasses the OS sandbox and is unavailable while sandboxing is enabled. Use sandboxed bash instead.",
  });
});

test("blocks eval Python execution while sandboxing is active", async () => {
  const coordinator = new SandboxCoordinator(
    "/root",
    new FakeRuntime(),
    async () => ({ ...DEFAULT_CONFIG, enabled: true }),
  );
  const harness = extensionHarness();
  const session = registerSandboxExtension(harness.api, coordinator);
  const notifications: string[] = [];
  const ctx = context("eval", notifications);

  await harness.handler("session_start")({ type: "session_start" }, ctx);
  const result = await harness.handler("user_python")(
    { type: "user_python", code: "raise RuntimeError('must not run')", cwd: ctx.cwd },
    ctx,
  );

  expect(session.ready).toBe(true);
  expect(result).toMatchObject({
    result: {
      output: "Python execution is unavailable while sandboxing is enabled. Use sandboxed bash.",
      exitCode: 1,
      displayOutputs: [],
      stdinRequested: false,
    },
  });
});

test("main commands transition every participant and reject busy transitions atomically", async () => {
  const runtime = new FakeRuntime();
  const coordinator = new SandboxCoordinator(
    "/root",
    runtime,
    async () => ({ ...DEFAULT_CONFIG, enabled: false }),
  );
  const mainHarness = extensionHarness();
  const childHarness = extensionHarness();
  const mainSession = registerSandboxExtension(mainHarness.api, coordinator);
  const childSession = registerSandboxExtension(childHarness.api, coordinator);
  const notifications: string[] = [];
  const mainContext = context("main", notifications);
  const childContext = context("child", notifications);

  await mainHarness.handler("session_start")({ type: "session_start" }, mainContext);
  await childHarness.handler("session_start")({ type: "session_start" }, childContext);
  expect(mainSession.active).toBe(false);
  expect(childSession.active).toBe(false);

  await mainHarness.command("sandbox-enable")("", mainContext);
  expect(mainSession.ready).toBe(true);
  expect(childSession.ready).toBe(true);
  expect(mainHarness.activeTools()).toEqual(["bash", "custom"]);
  expect(childHarness.activeTools()).toEqual(["bash", "custom"]);
  expect(runtime.initializations).toBe(1);

  let finishCommand: (() => void) | undefined;
  const running = mainSession.run(async () => {
    await new Promise<void>((resolve) => { finishCommand = resolve; });
  });
  await Promise.resolve();
  const resetsBeforeRefusal = runtime.resets;

  await childHarness.command("sandbox-allow")("domain blocked.test", childContext);
  expect(notifications.at(-1)).toContain("main");
  expect(runtime.resets).toBe(resetsBeforeRefusal);

  await mainHarness.command("sandbox-enable")("", mainContext);
  expect(notifications.at(-1)).toContain("main");
  expect(runtime.resets).toBe(resetsBeforeRefusal);

  await childHarness.command("sandbox-disable")("", childContext);

  expect(notifications.at(-1)).toContain("main");
  expect(notifications.at(-1)).toContain("Stop those commands");
  expect(mainSession.ready).toBe(true);
  expect(childSession.ready).toBe(true);
  expect(runtime.resets).toBe(resetsBeforeRefusal);
  expect(mainHarness.activeTools()).toEqual(["bash", "custom"]);
  expect(childHarness.activeTools()).toEqual(["bash", "custom"]);

  finishCommand?.();
  await running;
  await mainHarness.command("sandbox-disable")("", mainContext);
  expect(mainSession.active).toBe(false);
  expect(childSession.active).toBe(false);
  expect(mainHarness.activeTools()).toEqual(["bash", "custom", "grep", "glob"]);
  expect(childHarness.activeTools()).toEqual(["bash", "custom", "grep", "glob"]);

  const lateHarness = extensionHarness();
  const lateSession = registerSandboxExtension(lateHarness.api, coordinator);
  await lateHarness.handler("session_start")(
    { type: "session_start" },
    context("late", notifications),
  );
  expect(lateSession.active).toBe(false);
  expect(lateHarness.activeTools()).toEqual(["bash", "grep", "glob", "custom"]);

  await mainHarness.command("sandbox-enable")("", mainContext);
  expect(mainSession.ready).toBe(true);
  expect(childSession.ready).toBe(true);
  expect(lateSession.ready).toBe(true);
  expect(lateHarness.activeTools()).toEqual(["bash", "custom"]);
});
