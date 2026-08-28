import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { expect, test } from "bun:test";

import { DEFAULT_CONFIG, type SandboxConfig } from "../config.ts";
import {
  SandboxCommandsBlockedError,
  SandboxCoordinator,
  type SandboxRuntimeAdapter,
} from "../coordinator.ts";
import { SandboxSession, type HostToolVisibility } from "../session.ts";
import type { SessionAllowances } from "../runtime.ts";

class FakeRuntime implements SandboxRuntimeAdapter {
  readonly initializations: Array<{
    config: SandboxConfig;
    cwd: string;
    allowances: SessionAllowances;
    protectedWritePaths: string[];
  }> = [];
  resets = 0;

  async initialize(
    config: SandboxConfig,
    cwd: string,
    allowances: SessionAllowances,
    protectedWritePaths: string[],
  ): Promise<void> {
    this.initializations.push({ config, cwd, allowances, protectedWritePaths });
  }

  async reset(): Promise<void> {
    this.resets += 1;
  }
}

function context(id: string): ExtensionContext {
  return {
    cwd: `/workspace/${id}`,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id },
    ui: {
      notify() {},
      setStatus() {},
    },
  } as unknown as ExtensionContext;
}

function visibility(events: string[], label: string): HostToolVisibility {
  return {
    async hide() {
      events.push(`${label}:hide`);
    },
    async restore() {
      events.push(`${label}:restore`);
    },
  };
}

function coordinatorFor(
  config: SandboxConfig,
  runtime = new FakeRuntime(),
): { coordinator: SandboxCoordinator; runtime: FakeRuntime } {
  return {
    coordinator: new SandboxCoordinator("/root", runtime, async () => config),
    runtime,
  };
}

test("configured enabled false prevents startup activation but explicit enable reverses it", async () => {
  const config = { ...DEFAULT_CONFIG, enabled: false };
  const { coordinator, runtime } = coordinatorFor(config);
  const session = new SandboxSession({ coordinator, label: "Main" });

  await session.begin(context("main"));

  expect(session.active).toBe(false);
  expect(session.disabledReason).toBe("startup-configuration");
  expect(runtime.initializations).toHaveLength(0);

  expect(await session.enable(context("main"))).toBe(true);
  expect(session.ready).toBe(true);
  expect(runtime.initializations).toHaveLength(1);
  expect(runtime.initializations[0]?.cwd).toBe("/root");
});

test("no-sandbox is a reversible startup default", async () => {
  const { coordinator, runtime } = coordinatorFor(DEFAULT_CONFIG);
  const session = new SandboxSession({ coordinator, label: "Main" });

  await session.begin(context("main"), true);

  expect(session.active).toBe(false);
  expect(session.disabledReason).toBe("startup-flag");
  expect(runtime.initializations).toHaveLength(0);

  await session.enable(context("main"));
  expect(session.ready).toBe(true);
  expect(runtime.initializations).toHaveLength(1);
});

test("invalid configuration fails closed and blocks sandbox commands", async () => {
  const events: string[] = [];
  const coordinator = new SandboxCoordinator(
    "/root",
    new FakeRuntime(),
    async () => { throw new Error("sandbox.yaml is misconfigured: invalid YAML"); },
  );
  const session = new SandboxSession({
    coordinator,
    hostTools: visibility(events, "main"),
    label: "Main",
  });

  await session.begin(context("main"));

  expect(session.active).toBe(true);
  expect(session.ready).toBe(false);
  expect(session.failure).toContain("sandbox.yaml");
  expect(events).toContain("main:hide");
  await expect(session.enable(context("main"))).rejects.toBeInstanceOf(
    SandboxCommandsBlockedError,
  );
});

test("a valid plugin reload recovers from an invalid startup configuration", async () => {
  let valid = false;
  const runtime = new FakeRuntime();
  const coordinator = new SandboxCoordinator("/root", runtime, async () => {
    if (!valid) throw new Error("sandbox.yaml is misconfigured: invalid startup");
    return DEFAULT_CONFIG;
  });
  const failed = new SandboxSession({ coordinator, label: "Main" });
  await failed.begin(context("failed"));
  expect(failed.failure).toContain("sandbox.yaml");

  await failed.shutdown();
  valid = true;
  const replacement = new SandboxSession({ coordinator, label: "Main" });
  await replacement.begin(context("replacement"));

  expect(replacement.ready).toBe(true);
  expect(coordinator.status().configurationError).toBeUndefined();
  expect(runtime.initializations).toHaveLength(1);
});

test("failed reload keeps the last valid snapshot and active runtime", async () => {
  const runtime = new FakeRuntime();
  let reloadFails = false;
  const coordinator = new SandboxCoordinator("/root", runtime, async () => {
    if (reloadFails) throw new Error("sandbox.yaml is misconfigured: broken reload");
    return DEFAULT_CONFIG;
  });
  const main = new SandboxSession({ coordinator, label: "Main" });
  const child = new SandboxSession({ coordinator, label: "Child" });
  await main.begin(context("main"));
  await child.begin(context("child"));
  expect(runtime.initializations).toHaveLength(1);

  await main.shutdown();
  reloadFails = true;
  const replacement = new SandboxSession({ coordinator, label: "Main" });
  await replacement.begin(context("replacement"));

  expect(child.ready).toBe(true);
  expect(replacement.ready).toBe(true);
  expect(coordinator.configuration()).toBe(DEFAULT_CONFIG);
  expect(coordinator.status().configurationError).toContain("sandbox.yaml");
  expect(runtime.initializations).toHaveLength(1);
  await expect(replacement.disable(context("replacement"))).rejects.toBeInstanceOf(
    SandboxCommandsBlockedError,
  );
});

test("participants inherit process state and unregister on shutdown", async () => {
  const events: string[] = [];
  const { coordinator, runtime } = coordinatorFor(DEFAULT_CONFIG);
  const main = new SandboxSession({
    coordinator,
    hostTools: visibility(events, "main"),
    label: "Main",
  });
  await main.begin(context("main"));

  const child = new SandboxSession({
    coordinator,
    hostTools: visibility(events, "child"),
    label: "Child",
  });
  await child.begin(context("child"));

  expect(main.ready).toBe(true);
  expect(child.ready).toBe(true);
  expect(runtime.initializations).toHaveLength(1);
  expect(coordinator.status().participantCount).toBe(2);
  expect(events).toContain("child:hide");
  await child.refresh(context("child"), {
    domains: ["child.test"],
    readPaths: [],
    writePaths: [],
  });
  expect(runtime.initializations.at(-1)?.allowances.domains).toContain("child.test");

  await child.shutdown();
  expect(runtime.initializations.at(-1)?.allowances.domains).not.toContain("child.test");
  expect(coordinator.status().participantCount).toBe(1);
  expect(events).toContain("child:restore");
  expect(main.ready).toBe(true);
});

test("shutdown clears local state and retries after an active command blocks it", async () => {
  const events: string[] = [];
  const { coordinator } = coordinatorFor(DEFAULT_CONFIG);
  const session = new SandboxSession({
    coordinator,
    hostTools: visibility(events, "session"),
    label: "Session",
  });
  await session.begin(context("session"));
  let release: (() => void) | undefined;
  const activeCommand = session.run(() => new Promise<void>((resolve) => {
    release = resolve;
  }));

  await expect(session.shutdown()).rejects.toThrow("sandboxed commands are active");
  expect(session.ready).toBe(true);
  expect(events).not.toContain("session:restore");

  release?.();
  await activeCommand;
  await session.shutdown();

  expect(session.active).toBe(false);
  expect(session.ready).toBe(false);
  expect(session.allowances).toEqual({ domains: [], readPaths: [], writePaths: [] });
  expect(events).toContain("session:restore");
  expect(coordinator.status().participantCount).toBe(0);
});

test("session switch clears local allowances without changing root configuration", async () => {
  const { coordinator, runtime } = coordinatorFor(DEFAULT_CONFIG);
  const session = new SandboxSession({ coordinator, label: "Main" });
  await session.begin(context("first"));
  session.setAllowances({ domains: ["session.test"], readPaths: [], writePaths: [] });


  await session.switchContext(context("second"));

  expect(session.allowances.domains).toEqual([]);
  expect(coordinator.status().rootCwd).toBe("/root");
  expect(runtime.initializations.at(-1)?.cwd).toBe("/root");
});
test("persistent permission refresh updates the root policy for every participant", async () => {
  let diskConfig = DEFAULT_CONFIG;
  const runtime = new FakeRuntime();
  const coordinator = new SandboxCoordinator(
    "/root",
    runtime,
    async () => diskConfig,
  );
  const main = new SandboxSession({ coordinator, label: "Main" });
  const child = new SandboxSession({ coordinator, label: "Child" });
  await main.begin(context("main"));
  await child.begin(context("child"));

  await main.refresh(context("main"), main.allowances, async () => {
    diskConfig = {
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        allowedDomains: [
          ...(DEFAULT_CONFIG.network?.allowedDomains ?? []),
          "persisted.test",
        ],
      },
    };
  });

  expect((await main.effective()).domains).toContain("persisted.test");
  expect((await child.effective()).domains).toContain("persisted.test");
  expect(runtime.initializations).toHaveLength(2);
});

test("coordinator runtime transitions are isolated per process-local instance", async () => {
  const first = coordinatorFor({ ...DEFAULT_CONFIG, enabled: false });
  const second = coordinatorFor({ ...DEFAULT_CONFIG, enabled: false });
  const firstSession = new SandboxSession({
    coordinator: first.coordinator,
    label: "First",
  });
  const secondSession = new SandboxSession({
    coordinator: second.coordinator,
    label: "Second",
  });
  await firstSession.begin(context("first"));
  await secondSession.begin(context("second"));

  await firstSession.enable(context("first"));

  expect(firstSession.ready).toBe(true);
  expect(secondSession.active).toBe(false);
  expect(first.runtime.initializations).toHaveLength(1);
  expect(second.runtime.initializations).toHaveLength(0);
});

test("shared configuration changes require an explicit coordinator reload", async () => {
  let diskConfig = { ...DEFAULT_CONFIG, enabled: false };
  const firstRuntime = new FakeRuntime();
  const secondRuntime = new FakeRuntime();
  const firstCoordinator = new SandboxCoordinator(
    "/shared-root",
    firstRuntime,
    async () => diskConfig,
  );
  const secondCoordinator = new SandboxCoordinator(
    "/shared-root",
    secondRuntime,
    async () => diskConfig,
  );
  const firstSession = new SandboxSession({ coordinator: firstCoordinator, label: "First" });
  const secondSession = new SandboxSession({ coordinator: secondCoordinator, label: "Second" });
  await firstSession.begin(context("first"));
  await secondSession.begin(context("second"));

  diskConfig = { ...DEFAULT_CONFIG, enabled: true };
  expect(firstCoordinator.configuration().enabled).toBe(false);
  expect(secondCoordinator.configuration().enabled).toBe(false);

  await firstSession.shutdown();
  const reloadedSession = new SandboxSession({
    coordinator: firstCoordinator,
    label: "First",
  });
  await reloadedSession.begin(context("first-reloaded"));

  expect(firstCoordinator.configuration().enabled).toBe(true);
  expect(secondCoordinator.configuration().enabled).toBe(false);
});
