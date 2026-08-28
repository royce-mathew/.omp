import { getConfigPaths, loadConfig, type SandboxConfig } from "./config.ts";
import {
  initializeSandbox,
  resetSandbox,
  type SessionAllowances,
} from "./runtime.ts";

export type SandboxDisabledReason =
  | "startup-configuration"
  | "startup-flag"
  | "interactive";

export type SandboxParticipantState =
  | { kind: "disabled"; reason: SandboxDisabledReason }
  | { kind: "initializing" }
  | { kind: "enabled" }
  | { kind: "failed"; reason: string };

export interface SandboxParticipant {
  readonly id: string;
  label(): string;
  allowances: SessionAllowances;
  setAllowances(next: SessionAllowances): void;
  protectedWritePaths(): string[];
  applyState(state: SandboxParticipantState, config: SandboxConfig | undefined): Promise<void>;
}

export interface SandboxRuntimeAdapter {
  initialize(
    config: SandboxConfig,
    cwd: string,
    allowances: SessionAllowances,
    protectedWritePaths: string[],
  ): Promise<void>;
  reset(): Promise<void>;
}

export interface SandboxCoordinatorStatus {
  state: SandboxParticipantState;
  config: SandboxConfig | undefined;
  configurationError: string | undefined;
  paths: { globalPath: string; projectPath: string };
  rootCwd: string;
  projectConfigLoaded: boolean;
  startupConfiguredEnabled: boolean | undefined;
  startupNoSandbox: boolean;
  participantCount: number;
  interactiveOverride: "automatic" | "enabled" | "disabled";
}

type ConfigLoader = (cwd: string, includeProject: boolean) => Promise<SandboxConfig>;

const EMPTY_ALLOWANCES = (): SessionAllowances => ({
  domains: [],
  readPaths: [],
  writePaths: [],
});

const DEFAULT_RUNTIME: SandboxRuntimeAdapter = {
  initialize: initializeSandbox,
  reset: resetSandbox,
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class SandboxBusyError extends Error {
  constructor(readonly activeAgents: string[]) {
    super(
      `Sandbox transition refused; sandboxed commands are active in: ${activeAgents.join(", ")}. `
      + "Stop those commands before retrying.",
    );
    this.name = "SandboxBusyError";
  }
}

export class SandboxCommandsBlockedError extends Error {
  constructor(reason: string) {
    super(`${reason} Fix sandbox.yaml, then reload plugins or restart OMP.`);
    this.name = "SandboxCommandsBlockedError";
  }
}

/**
 * Owns the one process-global sandbox runtime without exporting process-global
 * policy. Each OMP process gets its own module instance and coordinator.
 */
export class SandboxCoordinator {
  readonly paths: { globalPath: string; projectPath: string };

  private readonly participants = new Map<string, SandboxParticipant>();
  private readonly activeExecutions = new Map<string, number>();
  private transitionTail: Promise<void> = Promise.resolve();
  private pendingTransitions = 0;
  private configSnapshot: SandboxConfig | undefined;
  private configError: string | undefined;
  private startupConfiguredEnabled: boolean | undefined;
  private startupNoSandbox = false;
  private interactiveOverride: "automatic" | "enabled" | "disabled" = "automatic";
  private projectConfigLoaded = false;
  private initialized = false;
  private reloadWhenInitialized = false;
  private rootParticipantId: string | undefined;
  private runtimeEnabled = false;
  private runtimeError: string | undefined;
  private deferredRuntimeRefresh = false;

  constructor(
    readonly rootCwd: string,
    private readonly runtime: SandboxRuntimeAdapter = DEFAULT_RUNTIME,
    private readonly configLoader: ConfigLoader = loadConfig,
  ) {
    this.paths = getConfigPaths(rootCwd);
  }

  register(participant: SandboxParticipant): void {
    if (this.participants.has(participant.id)) {
      throw new Error(`Sandbox participant already registered: ${participant.id}`);
    }
    if (this.initialized && this.participants.size === 0) this.reloadWhenInitialized = true;
    this.participants.set(participant.id, participant);
  }

  async unregister(participant: SandboxParticipant): Promise<void> {
    if (this.participants.get(participant.id) !== participant) return;
    if ((this.activeExecutions.get(participant.id) ?? 0) > 0) {
      throw new SandboxBusyError([participant.label()]);
    }
    if (participant.id === this.rootParticipantId) {
      this.rootParticipantId = undefined;
      this.reloadWhenInitialized = true;
    }
    const removedRuntimeAllowance = participant.allowances.domains.length > 0
      || participant.allowances.readPaths.length > 0
      || participant.allowances.writePaths.length > 0;
    this.participants.delete(participant.id);
    this.activeExecutions.delete(participant.id);
    if (!this.runtimeEnabled) return;
    if (this.participants.size === 0) {
      await this.transition(async () => {
        await this.runtime.reset().catch(() => undefined);
        this.runtimeEnabled = false;
      });
      return;
    }
    if (!removedRuntimeAllowance) return;
    if (this.activeExecutions.size > 0) {
      this.deferredRuntimeRefresh = true;
      return;
    }
    await this.transition(() => this.reinitializeCurrentRuntime());
  }

  async initializeParticipant(
    participant: SandboxParticipant,
    includeProject: boolean,
    noSandbox: boolean,
  ): Promise<void> {
    this.assertRegistered(participant);
    const mustLoad = !this.initialized || this.reloadWhenInitialized;
    let previousConfig: SandboxConfig | undefined;
    let loadedReplacement = false;
    if (mustLoad) {
      const firstLoad = !this.initialized;
      if (firstLoad) this.startupNoSandbox = noSandbox;
      previousConfig = this.configSnapshot;
      this.projectConfigLoaded = includeProject;
      try {
        const config = await this.configLoader(this.rootCwd, includeProject);
        this.configSnapshot = config;
        this.configError = undefined;
        loadedReplacement = !firstLoad;
        if (this.startupConfiguredEnabled === undefined) {
          this.startupConfiguredEnabled = config.enabled;
        }
      } catch (error) {
        this.configError = errorMessage(error);
      }
      this.initialized = true;
      this.reloadWhenInitialized = false;
      this.rootParticipantId ??= participant.id;
    }
    if (loadedReplacement && previousConfig && this.runtimeEnabled) {
      await this.replaceRuntimeConfiguration(previousConfig);
    }

    if (!this.configSnapshot) {
      await this.applyState(participant, this.currentState());
      return;
    }
    if (this.configError) {
      await this.applyState(participant, this.currentState());
      return;
    }
    if (this.shouldEnable()) {
      if (!this.runtimeEnabled) await this.enableRuntime();
      else await this.applyState(participant, { kind: "enabled" });
      return;
    }
    await this.applyState(participant, this.currentState());
  }

  configuration(): SandboxConfig {
    if (this.configSnapshot) return this.configSnapshot;
    throw new SandboxCommandsBlockedError(
      this.configError ?? "sandbox.yaml has not produced a valid configuration.",
    );
  }

  assertTransitionAvailable(): void {
    const activeAgents = this.activeAgentNames();
    if (activeAgents.length > 0) throw new SandboxBusyError(activeAgents);
    if (this.pendingTransitions > 0) {
      throw new Error("A sandbox runtime transition is already in progress.");
    }
    this.assertCommandsAvailable();
  }

  status(): SandboxCoordinatorStatus {
    return {
      state: this.currentState(),
      config: this.configSnapshot,
      configurationError: this.configError,
      paths: this.paths,
      rootCwd: this.rootCwd,
      projectConfigLoaded: this.projectConfigLoaded,
      startupConfiguredEnabled: this.startupConfiguredEnabled,
      startupNoSandbox: this.startupNoSandbox,
      interactiveOverride: this.interactiveOverride,
      participantCount: this.participants.size,
    };
  }

  async enable(): Promise<boolean> {
    return this.transition(async () => {
      this.assertCommandsAvailable();
      if (this.runtimeEnabled) return false;
      this.interactiveOverride = "enabled";
      await this.initializeRuntime();
      return true;
    });
  }

  async disable(): Promise<boolean> {
    return this.transition(async () => {
      this.assertCommandsAvailable();
      if (!this.runtimeEnabled && this.interactiveOverride === "disabled") return false;
      if (this.runtimeEnabled) await this.runtime.reset();
      this.runtimeEnabled = false;
      this.runtimeError = undefined;
      this.interactiveOverride = "disabled";
      await this.applyStateToAll(this.currentState());
      return true;
    });
  }

  async refreshPermissions(
    participant: SandboxParticipant,
    next: SessionAllowances,
    persist?: () => Promise<void>,
  ): Promise<void> {
    this.assertRegistered(participant);
    await this.transition(async () => {
      this.assertCommandsAvailable();
      const previousConfig = this.configuration();
      const previousAllowances = participant.allowances;

      await persist?.();
      let nextConfig = previousConfig;
      if (persist) {
        try {
          nextConfig = await this.configLoader(this.rootCwd, this.projectConfigLoaded);
        } catch (error) {
          this.configError = errorMessage(error);
          throw new SandboxCommandsBlockedError(this.configError);
        }
      }

      if (!this.runtimeEnabled) {
        this.configSnapshot = nextConfig;
        participant.setAllowances(next);
        return;
      }

      try {
        await this.runtime.reset();
        await this.runtime.initialize(
          nextConfig,
          this.rootCwd,
          this.combinedAllowances(participant, next),
          this.combinedProtectedWritePaths(),
        );
        this.configSnapshot = nextConfig;
        participant.setAllowances(next);
        this.runtimeError = undefined;
        await this.applyStateToAll({ kind: "enabled" });
      } catch (error) {
        try {
          await this.runtime.reset().catch(() => undefined);
          await this.runtime.initialize(
            previousConfig,
            this.rootCwd,
            this.combinedAllowances(participant, previousAllowances),
            this.combinedProtectedWritePaths(),
          );
          this.runtimeEnabled = true;
        } catch (rollbackError) {
          this.runtimeEnabled = false;
          this.runtimeError = errorMessage(rollbackError);
          await this.applyStateToAll(this.currentState());
        }
        throw error;
      }
    });
  }

  async run<T>(participant: SandboxParticipant, operation: () => Promise<T>): Promise<T> {
    this.assertRegistered(participant);
    if (this.pendingTransitions > 0) {
      throw new Error("Sandbox unavailable while a runtime transition is in progress.");
    }
    if (!this.runtimeEnabled) {
      throw new Error(this.unavailableMessage());
    }

    this.activeExecutions.set(
      participant.id,
      (this.activeExecutions.get(participant.id) ?? 0) + 1,
    );
    try {
      return await operation();
    } finally {
      const remaining = (this.activeExecutions.get(participant.id) ?? 1) - 1;
      if (remaining === 0) this.activeExecutions.delete(participant.id);
      else this.activeExecutions.set(participant.id, remaining);
      if (this.activeExecutions.size === 0 && this.deferredRuntimeRefresh) {
        this.deferredRuntimeRefresh = false;
        void this.transition(() => this.reinitializeCurrentRuntime()).catch(() => undefined);
      }
    }
  }

  unavailableMessage(): string {
    const state = this.currentState();
    if (state.kind === "failed") return `Sandbox unavailable; command blocked: ${state.reason}`;
    if (state.kind === "initializing") return "Sandbox unavailable; command blocked: initialization in progress";
    if (state.kind === "disabled") {
      return `Sandbox disabled: ${this.disabledReasonLabel(state.reason)}`;
    }
    return "Sandbox enabled";
  }

  private async enableRuntime(): Promise<void> {
    await this.transition(async () => {
      this.assertCommandsAvailable();
      await this.initializeRuntime();
    });
  }

  private async initializeRuntime(): Promise<void> {
    const config = this.configuration();
    if (process.platform !== "darwin" && process.platform !== "linux") {
      this.runtimeError = `Sandbox is not supported on ${process.platform}`;
      await this.applyStateToAll(this.currentState());
      return;
    }

    await this.applyStateToAll({ kind: "initializing" });
    try {
      await this.runtime.reset().catch(() => undefined);
      await this.runtime.initialize(
        config,
        this.rootCwd,
        this.combinedAllowances(),
        this.combinedProtectedWritePaths(),
      );
      this.runtimeEnabled = true;
      this.runtimeError = undefined;
      await this.applyStateToAll({ kind: "enabled" });
    } catch (error) {
      await this.runtime.reset().catch(() => undefined);
      this.runtimeEnabled = false;
      this.runtimeError = errorMessage(error);
      await this.applyStateToAll(this.currentState());
    }
  }

  private async replaceRuntimeConfiguration(previousConfig: SandboxConfig): Promise<void> {
    await this.transition(async () => {
      const nextConfig = this.configuration();
      try {
        await this.runtime.reset();
        await this.runtime.initialize(
          nextConfig,
          this.rootCwd,
          this.combinedAllowances(),
          this.combinedProtectedWritePaths(),
        );
      } catch (error) {
        this.configSnapshot = previousConfig;
        await this.runtime.reset().catch(() => undefined);
        try {
          await this.runtime.initialize(
            previousConfig,
            this.rootCwd,
            this.combinedAllowances(),
            this.combinedProtectedWritePaths(),
          );
          this.runtimeEnabled = true;
        } catch (rollbackError) {
          this.runtimeEnabled = false;
          this.runtimeError = errorMessage(rollbackError);
          await this.applyStateToAll(this.currentState());
        }
        throw error;
      }
    });
  }

  private shouldEnable(): boolean {
    if (this.interactiveOverride === "enabled") return true;
    if (this.interactiveOverride === "disabled") return false;
    return !this.startupNoSandbox && this.startupConfiguredEnabled !== false;
  }

  private currentState(): SandboxParticipantState {
    if (this.runtimeEnabled) return { kind: "enabled" };
    if (this.runtimeError) return { kind: "failed", reason: this.runtimeError };
    if (this.configError || !this.configSnapshot) {
      return {
        kind: "failed",
        reason: this.configError ?? "sandbox.yaml has not produced a valid configuration",
      };
    }
    if (this.interactiveOverride === "disabled") {
      return { kind: "disabled", reason: "interactive" };
    }
    if (this.interactiveOverride === "enabled") return { kind: "initializing" };
    if (this.startupNoSandbox) return { kind: "disabled", reason: "startup-flag" };
    return { kind: "disabled", reason: "startup-configuration" };
  }

  private async reinitializeCurrentRuntime(): Promise<void> {
    try {
      await this.runtime.reset();
      await this.runtime.initialize(
        this.configuration(),
        this.rootCwd,
        this.combinedAllowances(),
        this.combinedProtectedWritePaths(),
      );
    } catch (error) {
      await this.runtime.reset().catch(() => undefined);
      this.runtimeEnabled = false;
      this.runtimeError = errorMessage(error);
      await this.applyStateToAll(this.currentState());
    }
  }

  private async applyStateToAll(state: SandboxParticipantState): Promise<void> {
    await Promise.all([...this.participants.values()].map((participant) =>
      this.applyState(participant, state)));
  }

  private applyState(
    participant: SandboxParticipant,
    state: SandboxParticipantState,
  ): Promise<void> {
    return participant.applyState(state, this.configSnapshot);
  }

  private combinedAllowances(
    overrideParticipant?: SandboxParticipant,
    override?: SessionAllowances,
  ): SessionAllowances {
    const combined = EMPTY_ALLOWANCES();
    for (const participant of this.participants.values()) {
      const allowances = participant === overrideParticipant && override
        ? override
        : participant.allowances;
      combined.domains.push(...allowances.domains);
      combined.readPaths.push(...allowances.readPaths);
      combined.writePaths.push(...allowances.writePaths);
    }
    return {
      domains: [...new Set(combined.domains)],
      readPaths: [...new Set(combined.readPaths)],
      writePaths: [...new Set(combined.writePaths)],
    };
  }

  private combinedProtectedWritePaths(): string[] {
    return [...new Set([...this.participants.values()].flatMap((participant) =>
      participant.protectedWritePaths()))];
  }

  private assertCommandsAvailable(): void {
    if (this.configError) throw new SandboxCommandsBlockedError(this.configError);
    if (!this.configSnapshot) {
      throw new SandboxCommandsBlockedError("sandbox.yaml has no valid active configuration.");
    }
  }

  private assertRegistered(participant: SandboxParticipant): void {
    if (this.participants.get(participant.id) !== participant) {
      throw new Error(`Sandbox participant is not registered: ${participant.id}`);
    }
  }

  private disabledReasonLabel(reason: SandboxDisabledReason): string {
    if (reason === "startup-flag") return "startup --no-sandbox default";
    if (reason === "startup-configuration") return "startup configuration";
    return "interactive command";
  }

  private activeAgentNames(): string[] {
    return [...this.activeExecutions.keys()].map((id) =>
      this.participants.get(id)?.label() ?? id);
  }

  private transition<T>(operation: () => Promise<T>): Promise<T> {
    const activeAgents = this.activeAgentNames();
    if (activeAgents.length > 0) return Promise.reject(new SandboxBusyError(activeAgents));

    this.pendingTransitions += 1;
    const result = this.transitionTail.then(operation, operation);
    this.transitionTail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.pendingTransitions -= 1;
    });
  }
}

let processCoordinator: SandboxCoordinator | undefined;

export function getSandboxCoordinator(rootCwd = process.cwd()): SandboxCoordinator {
  processCoordinator ??= new SandboxCoordinator(rootCwd);
  return processCoordinator;
}

