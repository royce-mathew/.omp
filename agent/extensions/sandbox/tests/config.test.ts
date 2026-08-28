import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { stringify } from "yaml";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  DEFAULT_CONFIG,
  ensureGlobalConfigTemplate,
  getConfigPaths,
  loadConfig,
  mergeConfigLayers,
} from "../config.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(root);
  return root;
}

describe("sandbox configuration", () => {
  test("generates a complete global sandbox.yaml template without legacy grants", async () => {
    const root = temporaryRoot("pi-sandbox-template-");
    process.env.PI_CODING_AGENT_DIR = root;
    const globalPath = join(root, "sandbox.yaml");

    ensureGlobalConfigTemplate();

    const content = await readFile(globalPath, "utf8");
    expect(content).toContain("enabled: true");
    expect(content).toContain("permissionPromptTimeoutSeconds: 600");
    expect(content).toContain("network:");
    expect(content).toContain("filesystem:");
    expect(content).not.toContain("grants");

    await writeFile(globalPath, "custom content", "utf8");
    ensureGlobalConfigTemplate();
    expect(await readFile(globalPath, "utf8")).toBe("custom content");
  });

  test("merges arrays additively and scalars by project precedence", () => {
    const merged = mergeConfigLayers(
      DEFAULT_CONFIG,
      {
        enabled: true,
        permissionPromptTimeoutSeconds: 30,
        network: { allowedDomains: ["global.test", "shared.test"] },
        filesystem: { allowRead: ["/global", "/shared"] },
      },
      {
        enabled: false,
        permissionPromptTimeoutSeconds: 45,
        network: { allowedDomains: ["project.test", "shared.test"] },
        filesystem: { allowRead: ["/project", "/shared"] },
      },
    );

    expect(merged.enabled).toBe(false);
    expect(merged.permissionPromptTimeoutSeconds).toBe(45);
    expect(merged.network?.allowedDomains).toEqual([
      "global.test",
      "shared.test",
      "project.test",
    ]);
    expect(merged.filesystem?.allowRead).toEqual(["/global", "/shared", "/project"]);
  });

  test("preserves enabled false when no higher-precedence layer changes it", () => {
    const merged = mergeConfigLayers(DEFAULT_CONFIG, { enabled: false }, {});
    expect(merged.enabled).toBe(false);
  });

  test("uses defaults only when neither layer configures an array", () => {
    const merged = mergeConfigLayers(DEFAULT_CONFIG, {}, {});
    expect(merged.network?.allowedDomains).toEqual(DEFAULT_CONFIG.network?.allowedDomains);
    expect(merged.filesystem?.allowWrite).toEqual(DEFAULT_CONFIG.filesystem?.allowWrite);
  });

  test("loads root-level fields and lets project enabled false override global true", async () => {
    const agentRoot = temporaryRoot("pi-sandbox-global-");
    const projectRoot = temporaryRoot("pi-sandbox-project-");
    process.env.PI_CODING_AGENT_DIR = agentRoot;
    await writeFile(join(agentRoot, "sandbox.yaml"), stringify({
      enabled: true,
      permissionPromptTimeoutSeconds: 25,
      network: { allowedDomains: ["global.test"] },
      filesystem: { allowRead: ["/global"] },
    }));
    await mkdir(join(projectRoot, ".omp"), { recursive: true });
    await writeFile(join(projectRoot, ".omp", "sandbox.yaml"), stringify({
      enabled: false,
      network: { allowedDomains: ["project.test"] },
      filesystem: { allowWrite: ["/project"] },
    }));

    const config = await loadConfig(projectRoot);

    expect(config.enabled).toBe(false);
    expect(config.permissionPromptTimeoutSeconds).toBe(25);
    expect(config.network?.allowedDomains).toEqual(["global.test", "project.test"]);
    expect(config.filesystem?.allowRead).toEqual(["/global"]);
    expect(config.filesystem?.allowWrite).toEqual(["/project"]);
  });

  test("uses OMP's configured agent directory and root project directory", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent";
    expect(getConfigPaths("/workspace")).toEqual({
      globalPath: "/tmp/custom-agent/sandbox.yaml",
      projectPath: "/workspace/.omp/sandbox.yaml",
    });
  });

  test("does not interpret the removed grants format", async () => {
    const root = temporaryRoot("pi-sandbox-grants-");
    process.env.PI_CODING_AGENT_DIR = root;
    await writeFile(join(root, "sandbox.yaml"), stringify({
      grants: {
        domains: ["legacy.test"],
        readPaths: ["/legacy"],
      },
    }));

    const config = await loadConfig(root, false);

    expect(config.network?.allowedDomains).not.toContain("legacy.test");
    expect(config.filesystem?.allowRead).not.toContain("/legacy");
    expect(config).not.toHaveProperty("grants");
  });

  test("rejects malformed YAML with a sandbox configuration error", async () => {
    const root = temporaryRoot("pi-sandbox-invalid-");
    process.env.PI_CODING_AGENT_DIR = root;
    await writeFile(join(root, "sandbox.yaml"), "{ malformed");

    await expect(loadConfig(root, false)).rejects.toThrow("sandbox.yaml is misconfigured");
  });

  test("rejects invalid permission arrays instead of silently using defaults", async () => {
    const root = temporaryRoot("pi-sandbox-array-");
    process.env.PI_CODING_AGENT_DIR = root;
    await writeFile(join(root, "sandbox.yaml"), stringify({
      network: { allowedDomains: "example.test" },
    }));

    await expect(loadConfig(root, false)).rejects.toThrow(
      "network.allowedDomains must be an array of strings",
    );
  });

  test("fails closed instead of replacing malformed configuration during an update", async () => {
    const root = temporaryRoot("pi-sandbox-grant-failure-");
    const path = join(root, "sandbox.yaml");
    const malformed = "network: [unterminated";
    await writeFile(path, malformed);

    await expect(addDomainToConfig(path, "example.test")).rejects.toThrow(
      "sandbox.yaml is misconfigured",
    );
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  test("atomically preserves independently added permission rules", async () => {
    const root = temporaryRoot("pi-sandbox-atomic-");
    const path = join(root, "sandbox.yaml");

    await Promise.all([
      addDomainToConfig(path, "example.test"),
      addDomainToConfig(path, "api.example.test"),
      addReadPathToConfig(path, "/read"),
      addWritePathToConfig(path, "/write"),
    ]);

    const content = await readFile(path, "utf8");
    expect(content).toContain("example.test");
    expect(content).toContain("api.example.test");
    expect(content).toContain("/read");
    expect(content).toContain("/write");
    expect(existsSync(path)).toBe(true);
  });
});
