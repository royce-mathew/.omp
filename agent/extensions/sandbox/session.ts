import { dirname } from "node:path";

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import {
  SandboxCoordinator,
  type SandboxDisabledReason,
  type SandboxParticipant,
  type SandboxParticipantState,
} from "./coordinator.ts";
import type { SandboxConfig } from "./config.ts";
import {
  resolveAllowances,
  supportsNodeEnvProxy,
  type EffectiveAllowances,
  type SessionAllowances,
} from "./runtime.ts";
import { formatSandboxStatus } from "./ui.ts";

export interface HostToolVisibility {
  hide(): Promise<void>;
  restore(): Promise<void>;
}

interface SandboxSessionOptions {
  coordinator?: SandboxCoordinator;
  hostTools?: HostToolVisibility;
  label?: string;
}

const NOOP_HOST_TOOLS: HostToolVisibility = {
  async hide() {},
  async restore() {},
};

const emptyAllowances = (): SessionAllowances => ({
  domains: [],
  readPaths: [],
  writePaths: [],
});

let nextParticipantId = 1;

export class SandboxSession implements SandboxParticipant {
  readonly id = `sandbox-participant-${nextParticipantId++}`;

  private state: SandboxParticipantState = {
    kind: "disabled",
    reason: "startup-configuration",
  };
  private readonly coordinator: SandboxCoordinator;
  private readonly hostTools: HostToolVisibility;
  private readonly configuredLabel: string | undefined;
  private context: ExtensionContext | undefined;
  private registered = true;
  allowances: SessionAllowances = emptyAllowances();

  constructor(options: SandboxSessionOptions = {}) {
    this.coordinator = options.coordinator ?? new SandboxCoordinator(process.cwd());
    this.hostTools = options.hostTools ?? NOOP_HOST_TOOLS;
    this.configuredLabel = options.label;
    this.coordinator.register(this);
  }

  get active(): boolean {
    return this.state.kind !== "disabled";
  }

  get ready(): boolean {
    return this.state.kind === "enabled";
  }

  get failure(): string | undefined {
    return this.state.kind === "failed" ? this.state.reason : undefined;
  }

  get disabledReason(): SandboxDisabledReason | undefined {
    return this.state.kind === "disabled" ? this.state.reason : undefined;
  }

  get processCoordinator(): SandboxCoordinator {
    return this.coordinator;
  }

  async begin(ctx: ExtensionContext, noSandbox = false): Promise<void> {
    this.context = ctx;
    await this.coordinator.initializeParticipant(this, ctx.isProjectTrusted(), noSandbox);
  }

  async switchContext(ctx: ExtensionContext): Promise<void> {
    if (this.allowances.domains.length
      || this.allowances.readPaths.length
      || this.allowances.writePaths.length) {
      await this.coordinator.refreshPermissions(this, emptyAllowances());
    }
    this.context = ctx;
  }

  config(_ctx?: ExtensionContext): Promise<SandboxConfig> {
    return Promise.resolve(this.coordinator.configuration());
  }

  effective(_ctx?: ExtensionContext): Promise<EffectiveAllowances> {
    return Promise.resolve(resolveAllowances(this.coordinator.configuration(), this.allowances));
  }

  protectedWritePaths(): string[] {
    return [
      this.coordinator.paths.globalPath,
      dirname(this.coordinator.paths.projectPath),
    ];
  }

  blockedMessage(): string {
    return this.coordinator.unavailableMessage();
  }

  refresh(
    _ctx: ExtensionContext,
    next: SessionAllowances = this.allowances,
    persist?: () => Promise<void>,
  ): Promise<void> {
    return this.coordinator.refreshPermissions(this, next, persist);
  }

  async enable(ctx: ExtensionContext, quiet = false): Promise<boolean> {
    this.context = ctx;
    const changed = await this.coordinator.enable();
    if (!changed && !quiet) ctx.ui.notify("Sandbox is already enabled", "info");
    if (changed && !this.ready && !quiet) ctx.ui.notify(this.blockedMessage(), "error");
    return changed && this.ready;
  }

  async disable(ctx: ExtensionContext, quiet = false): Promise<boolean> {
    this.context = ctx;
    const changed = await this.coordinator.disable();
    if (!changed && !quiet) ctx.ui.notify("Sandbox is already disabled", "info");
    return changed;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.coordinator.run(this, operation);
  }

  async shutdown(): Promise<void> {
    if (!this.registered) return;
    await this.coordinator.unregister(this);
    this.state = { kind: "disabled", reason: "interactive" };
    this.allowances = emptyAllowances();
    await this.hostTools.restore();
    this.registered = false;
  }

  label(): string {
    if (this.configuredLabel) return this.configuredLabel;
    const sessionId = this.context?.sessionManager?.getSessionId();
    if (!sessionId) return this.id;
    const ref = AgentRegistry.global().list().find((candidate) =>
      candidate.session?.sessionManager.getSessionId() === sessionId);
    return ref?.displayName ?? ref?.id ?? sessionId;
  }

  setAllowances(next: SessionAllowances): void {
    this.allowances = next;
  }

  async applyState(
    state: SandboxParticipantState,
    config: SandboxConfig | undefined,
  ): Promise<void> {
    this.state = state;
    if (state.kind === "disabled") await this.hostTools.restore();
    else await this.hostTools.hide();

    const ctx = this.context;
    if (!ctx) return;
    if (state.kind === "disabled") {
      ctx.ui.setStatus("sandbox", undefined);
      return;
    }
    if (state.kind === "enabled" && config) {
      if (supportsNodeEnvProxy(process.versions.node)) process.env.NODE_USE_ENV_PROXY ??= "1";
      ctx.ui.setStatus("sandbox", formatSandboxStatus(config));
      return;
    }
    if (state.kind === "initializing") {
      ctx.ui.setStatus("sandbox", "sandbox initializing");
      return;
    }
    ctx.ui.setStatus("sandbox", "sandbox unavailable · commands blocked");
  }
}
