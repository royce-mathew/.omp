import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent"

import { promptPermission } from "../ui.ts";

function contextSelecting(selected: string | string[], confirmed = true): ExtensionContext {
  const selections = Array.isArray(selected) ? [...selected] : [selected];
  return {
    cwd: "/workspace",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      select: async () => selections.shift(),
      confirm: async () => confirmed,
    },
  } as unknown as ExtensionContext;
}

test("filesystem prompts can grant a parent directory at every scope", async () => {
  expect(await promptPermission(
    contextSelecting(["Allow parent directory…", "For this session"]),
    "blocked",
    "/workspace/src/file.ts",
    0,
    true,
  )).toEqual({ action: "session", value: "/workspace/src" });

  expect(await promptPermission(
    contextSelecting(["Allow parent directory…", "For this project"]),
    "blocked",
    "/workspace/src/file.ts",
    0,
    true,
  )).toEqual({ action: "project", value: "/workspace/src" });
});

test("domain prompts do not reinterpret domains as paths", async () => {
  expect(await promptPermission(
    contextSelecting("Allow this path for this session"),
    "blocked",
    "example.test:443",
    0,
  )).toEqual({ action: "session", value: "example.test:443" });
});

test("unknown permission selections fail closed", async () => {
  expect(await promptPermission(
    contextSelecting("unexpected-option"),
    "blocked",
    "/workspace/file.ts",
    0,
    true,
  )).toEqual({ action: "abort", value: "/workspace/file.ts" });

  expect(await promptPermission(
    contextSelecting(["Allow parent directory…", "unexpected-scope"]),
    "blocked",
    "/workspace/src/file.ts",
    0,
    true,
  )).toEqual({ action: "abort", value: "/workspace/src/file.ts" });
});
