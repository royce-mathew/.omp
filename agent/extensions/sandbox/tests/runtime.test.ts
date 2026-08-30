import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../config.ts";
import { canonicalizePath } from "../policy.ts";
import {
  buildRuntimeConfig,
  extractBlockedWritePath,
  resolveAllowances,
  supportsNodeEnvProxy,
} from "../runtime.ts";

describe("sandbox runtime adapter", () => {
  test("combines session allowances without mutating configuration", () => {
    const effective = resolveAllowances(DEFAULT_CONFIG, {
      domains: ["example.test"],
      readPaths: ["/read"],
      writePaths: ["/write"],
    });
    expect(effective.domains).toContain("example.test");
    expect(effective.readPaths).toContain("/write");
    expect(DEFAULT_CONFIG.network?.allowedDomains).not.toContain("example.test");
  });

  test("canonicalizes paths and protects configuration from shell writes", () => {
    const config = buildRuntimeConfig(
      {
        ...DEFAULT_CONFIG,
        filesystem: {
          ...DEFAULT_CONFIG.filesystem,
          denyRead: ["/tmp"],
          allowRead: [],
          allowWrite: ["/tmp"],
          denyWrite: [],
        },
      },
      "/workspace",
      undefined,
      ["/workspace/.pi"],
    );
    expect(config.filesystem?.denyRead).toEqual([canonicalizePath("/tmp")]);
    expect(config.filesystem?.allowWrite).toEqual([canonicalizePath("/tmp")]);
    expect(config.filesystem?.denyWrite).toContain("/workspace/.pi");
    expect(config).not.toHaveProperty("enabled");
    expect(config).not.toHaveProperty("permissionPromptTimeoutSeconds");
  });

  test("allows the Linux seccomp helper outside the sandbox working directory", () => {
    const runtimeEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"));
    const seccompHelper = join(
      dirname(runtimeEntry),
      "..",
      "vendor",
      "seccomp",
      process.arch,
      "apply-seccomp",
    );
    const config = buildRuntimeConfig(DEFAULT_CONFIG, "/workspace");

    expect(config.filesystem?.allowRead).toContain(seccompHelper);
  });

  test("rejects unsupported Linux filesystem globs instead of weakening policy", () => {
    const cases = [
      ["denyRead", "**/.env"],
      ["allowRead", "src/**/*.ts"],
      ["allowWrite", "build/*"],
      ["denyWrite", "*.key"],
    ] as const;
    for (const [field, pattern] of cases) {
      const config = {
        ...DEFAULT_CONFIG,
        filesystem: { ...DEFAULT_CONFIG.filesystem, [field]: [pattern] },
      };
      expect(() => buildRuntimeConfig(config, "/workspace", undefined, [], "linux"))
        .toThrow(`filesystem.${field}`);
    }

    const macConfig = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      filesystem: { ...DEFAULT_CONFIG.filesystem, denyWrite: ["*.key"] },
    }, "/workspace", undefined, [], "darwin");
    expect(macConfig.filesystem?.denyWrite).toEqual(["*.key"]);
  });

  test("recognizes common blocked-write diagnostics", () => {
    expect(extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"))
      .toBe("/private/file");
    expect(extractBlockedWritePath("Error: EPERM: operation not permitted, open '/tmp/file'"))
      .toBe("/tmp/file");
  });


  test("detects Node versions with environment proxy support", () => {
    expect(supportsNodeEnvProxy("22.20.0")).toBe(false);
    expect(supportsNodeEnvProxy("22.21.0")).toBe(true);
    expect(supportsNodeEnvProxy("23.9.0")).toBe(false);
    expect(supportsNodeEnvProxy("24.0.0")).toBe(true);
  });
});
