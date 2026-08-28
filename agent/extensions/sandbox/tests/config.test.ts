import { stringify, parse } from "yaml";
import { mkdtempSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  DEFAULT_CONFIG,
  getConfigPaths,
  ensureGlobalConfigTemplate,
  loadConfig,
  mergeConfigLayers,
} from "../config.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("sandbox configuration", () => {
  test("generates global sandbox.yaml template if missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-template-"));
    process.env.PI_CODING_AGENT_DIR = root;
    const globalPath = join(root, "sandbox.yaml");
    
    expect(existsSync(globalPath)).toBe(false);
    
    ensureGlobalConfigTemplate();
    
    expect(existsSync(globalPath)).toBe(true);
    const content = await readFile(globalPath, "utf8");
    expect(content).toContain("Global Oh My Pi Sandbox Configuration");
    expect(content).toContain("allowRead:");
    expect(content).toContain("# - ~/.gitconfig");
    
    // Ensure it doesn't overwrite existing files
    await writeFile(globalPath, "custom content", "utf8");
    ensureGlobalConfigTemplate();
    expect(await readFile(globalPath, "utf8")).toBe("custom content");
  });

  test("merges arrays additively and scalars by project precedence", () => {
    const merged = mergeConfigLayers(
      DEFAULT_CONFIG,
      {
        enabled: false,
        network: { allowedDomains: ["global.test", "shared.test"] },
        filesystem: { allowWrite: ["/global"] },
      },
      {
        enabled: true,
        network: { allowedDomains: ["project.test", "shared.test"] },
        filesystem: { allowWrite: ["/project"] },
      },
    );
    expect(merged.enabled).toBe(true);
    expect(merged.network?.allowedDomains).toEqual([
      "global.test",
      "shared.test",
      "project.test",
    ]);
    expect(merged.filesystem?.allowWrite).toEqual(["/global", "/project"]);
  });

  test("uses defaults only when neither layer configures an array", () => {
    const merged = mergeConfigLayers(DEFAULT_CONFIG, { filesystem: { allowWrite: [] } }, {});
    expect(merged.filesystem?.allowWrite).toEqual([]);
    expect(merged.filesystem?.allowRead).toEqual(DEFAULT_CONFIG.filesystem?.allowRead);
  });

  test("keeps incremental grants separate from explicit array replacement", () => {
    const merged = mergeConfigLayers(
      DEFAULT_CONFIG,
      {
        network: { allowedDomains: [] },
        filesystem: { allowRead: [], allowWrite: [] },
        grants: {
          domains: ["global-grant.test"],
          readPaths: ["/global-read"],
          writePaths: ["/global-write"],
        },
      },
      {
        grants: {
          domains: ["project-grant.test"],
          readPaths: ["/project-read"],
          writePaths: ["/project-write"],
        },
      },
    );
    expect(merged.network?.allowedDomains).toEqual([
      "global-grant.test",
      "project-grant.test",
    ]);
    expect(merged.filesystem?.allowRead).toEqual(["/global-read", "/project-read"]);
    expect(merged.filesystem?.allowWrite).toEqual(["/global-write", "/project-write"]);
  });

  test("uses OMP's configured agent and project config directories", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent";
    expect(getConfigPaths("/workspace")).toEqual({
      globalPath: "/tmp/custom-agent/sandbox.yaml",
      projectPath: "/workspace/.omp/sandbox.yaml",
    });
  });

  test("rejects malformed runtime configuration at the load boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-invalid-"));
    process.env.PI_CODING_AGENT_DIR = root;
    await writeFile(join(root, "sandbox.yaml"), stringify({
      network: { strictAllowlist: "yes" },
    }));
    await expect(loadConfig(root, false)).rejects.toThrow("invalid sandbox configuration");
  });

  test("fails closed instead of replacing malformed configuration during a grant", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-malformed-"));
    const path = join(root, "sandbox.yaml");
    await writeFile(path, "{ malformed");
    await expect(addReadPathToConfig(path, "/read")).rejects.toThrow(
      "could not read sandbox configuration",
    );
    expect(await readFile(path, "utf8")).toBe("{ malformed");
  });

  test("atomically preserves independently added permission rules", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
    process.env.PI_CODING_AGENT_DIR = root;
    const path = join(root, "sandbox.yaml");
    await Promise.all([
      addReadPathToConfig(path, "/read"),
      addWritePathToConfig(path, "/write"),
      addDomainToConfig(path, "example.test"),
    ]);
    expect(parse(await readFile(path, "utf8"))).toEqual({
      grants: {
        domains: ["example.test"],
        readPaths: ["/read"],
        writePaths: ["/write"],
      },
    });
    const reloaded = await loadConfig(root, false);
    expect(reloaded.network?.allowedDomains).toContain("github.com");
    expect(reloaded.network?.allowedDomains).toContain("example.test");
    expect(reloaded.filesystem?.allowRead).toContain("/read");
    expect(reloaded.filesystem?.allowWrite).toContain("/write");
  });

  test("normalizes the generated legacy Linux deny list before validation", async () => {
    if (process.platform !== "linux") return;
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-legacy-"));
    process.env.PI_CODING_AGENT_DIR = root;
    await writeFile(join(root, "sandbox.yaml"), stringify({
      filesystem: { denyWrite: [".env", ".env.*", "*.pem", "*.key"] },
    }));
    const config = await loadConfig(root, false);
    expect(config.filesystem?.denyWrite).toEqual([".env"]);
  });
});
