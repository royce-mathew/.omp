import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import quotaStatus from "../index.ts";

describe("provider quota extension", () => {
  test("publishes active OAuth quota from provider response headers", async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const updates: unknown[] = [];
    const commands = new Map<string, unknown>();
    // The extension API surface is intentionally larger than this focused test double.
    const pi = {
      on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
      events: { emit: (name: string, data: unknown) => { if (name === "workspace-ui:quota") updates.push(data); } },
      registerCommand(name: string, command: unknown) { commands.set(name, command); },
    } as unknown as ExtensionAPI;
    // The extension only reads these mocked context members in this test.
    const context = {
      model: { provider: "openai-codex", id: "gpt-test" },
      modelRegistry: { isUsingOAuth: () => true },
      ui: { theme: { fg: (_color: string, text: string) => text } },
    } as unknown as ExtensionContext;

    quotaStatus(pi);
    expect(commands.has("quota")).toBe(true);
    await handlers.get("after_provider_response")?.({
      status: 200,
      headers: {
        "x-codex-primary-used-percent": "20",
        "x-codex-primary-reset-at": "2000000000",
      },
    }, context);

    expect(updates.at(-1)).toMatchObject({ text: expect.stringContaining("5-hour: 80% remaining"), remainingPercent: 80 });
  });
});
