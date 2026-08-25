import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import sandboxExtension, {
  createHostToolVisibility,
  sandboxToolBlockReason,
} from "../index.ts";

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
    "custom",
  ];
  const visibility = createHostToolVisibility({
    getActiveTools: () => [...active],
    setActiveTools: async (tools) => {
      active = [...tools];
    },
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
  ]);
});

test("tool-call backstop covers every hidden OMP tool", () => {
  const hidden = ["grep", "glob", "lsp", "python", "notebook", "inspect_image"];
  const tools = ["bash", "read", "write", "edit", ...hidden, "custom"];
  const unavailable = "Sandbox unavailable; command blocked";
  const readyBlocked = tools.filter((tool) => sandboxToolBlockReason(tool, true, unavailable));
  const failedBlocked = tools.filter((tool) => sandboxToolBlockReason(tool, false, unavailable));

  expect(readyBlocked).toEqual(hidden);
  expect(failedBlocked).toEqual(["bash", ...hidden]);
  for (const tool of hidden) {
    expect(sandboxToolBlockReason(tool, true, unavailable))
      .toBe(`The ${tool} tool bypasses the OS sandbox and is unavailable while sandboxing is enabled. Use sandboxed bash instead.`);
  }
  expect(sandboxToolBlockReason("custom", true, unavailable)).toBeUndefined();
});

test("registers the bash override and complete sandbox lifecycle", () => {
  const registered: Array<{ name: string; parameters: unknown }> = [];
  const registeredEvents: string[] = [];
  const pi = {
    typebox: {
      Type: {
        String: () => ({ type: "string" }),
        Number: () => ({ type: "number" }),
        Boolean: () => ({ type: "boolean" }),
        Record: () => ({ type: "object" }),
        Optional: (value: unknown) => value,
        Object: (properties: unknown) => ({ type: "object", properties }),
      },
    },
    registerTool: (tool: { name: string; parameters: unknown }) => registered.push(tool),
    registerFlag() {},
    getFlag: () => false,
    registerShortcut() {},
    registerCommand() {},
    on: (event: string) => registeredEvents.push(event),
    getActiveTools: () => ["bash"],
    setActiveTools: async () => {},
    events: { emit() {} },
  } as unknown as ExtensionAPI;

  sandboxExtension(pi);
  expect(registered).toHaveLength(1);
  expect(registered[0]?.name).toBe("bash");
  expect(registered[0]?.parameters).toBeDefined();
  expect(registeredEvents).toContain("session_start");
  expect(registeredEvents).toContain("session_switch");
  expect(registeredEvents).toContain("session_shutdown");
});
