import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SandboxSession } from "../session.ts";

const context = { cwd: "/workspace" } as ExtensionContext;
const allowance = { domains: ["example.test"], readPaths: [], writePaths: [] };

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryPaths: string[] = [];
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function configContext(cwd: string): ExtensionContext {
  return {
    cwd,
    isProjectTrusted: () => false,
    ui: {
      setStatus() {},
    },
  } as unknown as ExtensionContext;
}

test("does not apply allowances when persistence fails", async () => {
  const session = new SandboxSession();
  await expect(session.refresh(context, allowance, async () => {
    throw new Error("save failed");
  })).rejects.toThrow("save failed");
  expect(session.allowances.domains).toEqual([]);
});

test("applies allowances only after persistence succeeds", async () => {
  const session = new SandboxSession();
  await session.refresh(context, allowance, async () => {});
  expect(session.allowances).toEqual(allowance);
});

test("retries configuration reads after a cached failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-retry-"));
  temporaryPaths.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  const path = join(root, "sandbox.json");
  const session = new SandboxSession();
  const ctx = configContext(root);

  writeFileSync(path, "{ malformed");
  await expect(session.config(ctx)).rejects.toThrow("could not read sandbox configuration");
  writeFileSync(path, "{}");
  await expect(session.config(ctx)).resolves.toMatchObject({ enabled: true });
});

test("reloads successful configuration snapshots explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-reload-"));
  temporaryPaths.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  const path = join(root, "sandbox.json");
  const session = new SandboxSession();
  const ctx = configContext(root);

  writeFileSync(path, JSON.stringify({ enabled: false }));
  await expect(session.config(ctx)).resolves.toMatchObject({ enabled: false });
  writeFileSync(path, JSON.stringify({ enabled: true }));
  await expect(session.reloadConfig(ctx)).resolves.toMatchObject({ enabled: true });
});

test("reset clears permissions owned by the previous session", async () => {
  const session = new SandboxSession();
  session.allowances = allowance;
  await session.reset(configContext("/workspace"));
  expect(session.allowances).toEqual({ domains: [], readPaths: [], writePaths: [] });
});
