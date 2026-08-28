import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent"

import { DEFAULT_CONFIG } from "../config.ts";
import { formatSandboxConfiguration, promptPermission } from "../ui.ts";

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

test("status reports effective state, root inputs, timeout, permissions, and trust", () => {
  const output = formatSandboxConfiguration({
    state: { kind: "disabled", reason: "startup-configuration" },
    config: DEFAULT_CONFIG,
    configurationError: undefined,
    paths: {
      globalPath: "/agent/sandbox.yaml",
      projectPath: "/root/.omp/sandbox.yaml",
    },
    rootCwd: "/root",
    projectConfigLoaded: false,
    startupConfiguredEnabled: false,
    startupNoSandbox: false,
    participantCount: 1,
    interactiveOverride: "automatic",
  }, {
    domains: ["session.test"],
    readPaths: ["/session/read"],
    writePaths: ["/session/write"],
  });

  expect(output).toContain("Disabled (startup configuration)");
  expect(output).toContain("/agent/sandbox.yaml");
  expect(output).toContain("/root/.omp/sandbox.yaml (ignored: project not trusted)");
  expect(output).toContain("Startup enabled: false");
  expect(output).toContain("Permission prompt timeout: 600 seconds");
  expect(output).toContain("session.test");
  expect(output).toContain("/session/read");
  expect(output).toContain("/session/write");
});
