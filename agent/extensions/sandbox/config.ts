import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { parse, parseDocument, type Document, type YAMLSeq, type YAMLMap } from "yaml";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export type SandboxConfig = SandboxRuntimeConfig & {
  enabled: boolean;
  permissionPromptTimeoutSeconds: number;
};

type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export class SandboxConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`sandbox.yaml is misconfigured: ${message}`, options);
    this.name = "SandboxConfigurationError";
  }
}

export type SandboxConfigFile = Omit<Partial<SandboxConfig>, "network" | "filesystem"> & {
  network?: Partial<NetworkConfig>;
  filesystem?: Partial<FilesystemConfig>;
};

export const DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS = 10 * 60;

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  permissionPromptTimeoutSeconds: DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["/Users", "/home"],
    allowRead: [".", "~/.config", "~/.local"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env"],
  },
};

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value;
}

function validateSection(
  name: "network" | "filesystem",
  value: unknown,
): void {
  if (value !== undefined
    && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error(`${name} must be a YAML object`);
  }
}

function validatePermissionArrays(config: SandboxConfigFile): void {
  const arrays = [
    ["network.allowedDomains", config.network?.allowedDomains],
    ["network.deniedDomains", config.network?.deniedDomains],
    ["network.allowUnixSockets", config.network?.allowUnixSockets],
    ["network.allowMachLookup", config.network?.allowMachLookup],
    ["filesystem.denyRead", config.filesystem?.denyRead],
    ["filesystem.allowRead", config.filesystem?.allowRead],
    ["filesystem.allowWrite", config.filesystem?.allowWrite],
    ["filesystem.denyWrite", config.filesystem?.denyWrite],
  ] as const;
  for (const [name, value] of arrays) {
    if (value !== undefined && stringArray(value) === undefined) {
      throw new Error(`${name} must be an array of strings`);
    }
  }
}

function mergeConfiguredArray(
  fallback: string[] | undefined,
  globalValue: unknown,
  projectValue: unknown,
): string[] | undefined {
  const globalEntries = stringArray(globalValue);
  const projectEntries = stringArray(projectValue);
  if (globalEntries === undefined && projectEntries === undefined) return fallback;
  return [...new Set([...(globalEntries ?? []), ...(projectEntries ?? [])])];
}

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
  return {
    ...base,
    ...overrides,
    network: overrides.network
      ? ({ ...base.network, ...overrides.network } as NetworkConfig)
      : base.network,
    filesystem: overrides.filesystem
      ? ({ ...base.filesystem, ...overrides.filesystem } as FilesystemConfig)
      : base.filesystem,
  };
}

/** Merge scalar values by precedence and permission arrays additively. */
export function mergeConfigLayers(
  defaults: SandboxConfig,
  globalConfig: SandboxConfigFile,
  projectConfig: SandboxConfigFile,
): SandboxConfig {
  const merged = mergeObjects(mergeObjects(defaults, globalConfig), projectConfig);
  return {
    ...merged,
    network: {
      ...merged.network,
      allowedDomains: mergeConfiguredArray(
        defaults.network?.allowedDomains,
        globalConfig.network?.allowedDomains,
        projectConfig.network?.allowedDomains,
      ) ?? [],
      deniedDomains: mergeConfiguredArray(
        defaults.network?.deniedDomains,
        globalConfig.network?.deniedDomains,
        projectConfig.network?.deniedDomains,
      ) ?? [],
      allowUnixSockets: mergeConfiguredArray(
        defaults.network?.allowUnixSockets,
        globalConfig.network?.allowUnixSockets,
        projectConfig.network?.allowUnixSockets,
      ),
      allowMachLookup: mergeConfiguredArray(
        defaults.network?.allowMachLookup,
        globalConfig.network?.allowMachLookup,
        projectConfig.network?.allowMachLookup,
      ),
    },
    filesystem: {
      ...merged.filesystem,
      denyRead: mergeConfiguredArray(
        defaults.filesystem?.denyRead,
        globalConfig.filesystem?.denyRead,
        projectConfig.filesystem?.denyRead,
      ) ?? [],
      allowRead: mergeConfiguredArray(
        defaults.filesystem?.allowRead,
        globalConfig.filesystem?.allowRead,
        projectConfig.filesystem?.allowRead,
      ) ?? [],
      allowWrite: mergeConfiguredArray(
        defaults.filesystem?.allowWrite,
        globalConfig.filesystem?.allowWrite,
        projectConfig.filesystem?.allowWrite,
      ) ?? [],
      denyWrite: mergeConfiguredArray(
        defaults.filesystem?.denyWrite,
        globalConfig.filesystem?.denyWrite,
        projectConfig.filesystem?.denyWrite,
      ) ?? [],
    },
  };
}

async function readYamlConfig(path: string): Promise<SandboxConfigFile> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("configuration must be a YAML object");
    }
    return parsed as SandboxConfigFile;
  } catch (error) {
    throw new SandboxConfigurationError(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}


export function ensureGlobalConfigTemplate(): void {
  const { globalPath } = getConfigPaths("");
  if (existsSync(globalPath)) return;
  try {
    const yamlContent = `# Global Oh My Pi Sandbox Configuration
# This file is the source of truth for sandbox startup and permissions.

enabled: true
permissionPromptTimeoutSeconds: 600

network:
  allowedDomains:
    - npmjs.org
    - "*.npmjs.org"
    - registry.npmjs.org
    - registry.yarnpkg.com
    - pypi.org
    - "*.pypi.org"
    - github.com
    - "*.github.com"
    - api.github.com
    - raw.githubusercontent.com
  deniedDomains: []

filesystem:
  denyRead:
    - /Users
    - /home
  allowRead:
    - .
    - ~/.config
    - ~/.local
    # Uncomment to allow agents to read your global git config:
    # - ~/.gitconfig
  allowWrite:
    - .
    - /tmp
  denyWrite:
    - .env
`;
    writeFileSync(globalPath, yamlContent, "utf8");
  } catch {
    // A read-only agent directory should not prevent the extension from loading.
  }
}

export function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(process.env.PI_CODING_AGENT_DIR ?? getAgentDir(), "sandbox.yaml"),
    projectPath: join(cwd, ".omp", "sandbox.yaml"),
  };
}

function validateConfig(config: SandboxConfig): SandboxConfig {
  const { enabled, permissionPromptTimeoutSeconds, ...runtimeConfig } = config;
  if (typeof enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (typeof permissionPromptTimeoutSeconds !== "number"
    || !Number.isFinite(permissionPromptTimeoutSeconds)
    || permissionPromptTimeoutSeconds < 0) {
    throw new Error("permissionPromptTimeoutSeconds must be a non-negative finite number");
  }
  const parsed = SandboxRuntimeConfigSchema.safeParse(runtimeConfig);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "configuration"}: ${issue.message}`).join("; ");
    throw new Error(issues);
  }
  return { ...parsed.data, enabled, permissionPromptTimeoutSeconds };
}
export async function loadConfig(cwd: string, includeProject = true): Promise<SandboxConfig> {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  try {
    const [globalConfig, projectConfig] = await Promise.all([
      readYamlConfig(globalPath),
      includeProject ? readYamlConfig(projectPath) : Promise.resolve({} as SandboxConfigFile),
    ]);
    validateSection("network", globalConfig.network);
    validateSection("filesystem", globalConfig.filesystem);
    validateSection("network", projectConfig.network);
    validateSection("filesystem", projectConfig.filesystem);
    validatePermissionArrays(globalConfig);
    validatePermissionArrays(projectConfig);
    return validateConfig(mergeConfigLayers(DEFAULT_CONFIG, globalConfig, projectConfig));
  } catch (error) {
    if (error instanceof SandboxConfigurationError) throw error;
    throw new SandboxConfigurationError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

const saveQueues = new Map<string, Promise<void>>();

async function updateConfig(
  path: string,
  update: (doc: Document) => void,
): Promise<void> {
  const previous = saveQueues.get(path) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    let source = "";
    if (existsSync(path)) {
      source = await readFile(path, "utf8");
    }
    const doc = parseDocument(source || "{}");
    if (doc.errors.length > 0) {
      throw new SandboxConfigurationError(
        `${path}: ${doc.errors.map((error) => error.message).join("; ")}`,
      );
    }
    update(doc);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, doc.toString(), "utf8");
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  });
  saveQueues.set(path, task);
  try {
    await task;
  } finally {
    if (saveQueues.get(path) === task) saveQueues.delete(path);
  }
}

async function addUniqueRule(
  path: string,
  kind: "domain" | "read" | "write",
  value: string,
): Promise<void> {
  await updateConfig(path, (doc) => {
    const parentKey = kind === "domain" ? "network" : "filesystem";
    const key = kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
    
    if (!doc.has(parentKey)) {
      doc.set(parentKey, doc.createNode({}));
    }
    const parent = doc.get(parentKey) as YAMLMap;
    if (!parent.has(key)) {
      parent.set(key, doc.createNode([]));
    }
    const seq = parent.get(key) as YAMLSeq;
    const items = seq.items.map((node: any) => node.value);
    if (!items.includes(value)) {
      seq.add(value);
    }
  });
}

export const addDomainToConfig = (path: string, value: string) =>
  addUniqueRule(path, "domain", value);
export const addReadPathToConfig = (path: string, value: string) =>
  addUniqueRule(path, "read", value);
export const addWritePathToConfig = (path: string, value: string) =>
  addUniqueRule(path, "write", value);
