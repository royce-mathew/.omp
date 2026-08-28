import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export type SandboxConfig = SandboxRuntimeConfig & {
  enabled?: boolean;
  permissionPromptTimeoutSeconds?: number;
};

type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export interface SandboxGrantConfig {
  domains?: string[];
  readPaths?: string[];
  writePaths?: string[];
}

export type SandboxConfigFile = Omit<Partial<SandboxConfig>, "network" | "filesystem"> & {
  network?: Partial<NetworkConfig>;
  filesystem?: Partial<FilesystemConfig>;
  grants?: SandboxGrantConfig;
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

function configuredGrantEntries(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  const entries = stringArray(value);
  if (entries === undefined) {
    throw new Error(`sandbox grants.${field} must be an array of strings`);
  }
  return entries;
}

function mergeGrantArray(
  base: string[],
  globalValue: unknown,
  projectValue: unknown,
  field: string,
): string[] {
  return [...new Set([
    ...base,
    ...configuredGrantEntries(globalValue, field),
    ...configuredGrantEntries(projectValue, field),
  ])];
}

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
  const { grants: _grants, ...runtimeOverrides } = overrides;
  return {
    ...base,
    ...runtimeOverrides,
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
      allowedDomains: mergeGrantArray(
        mergeConfiguredArray(
          defaults.network?.allowedDomains,
          globalConfig.network?.allowedDomains,
          projectConfig.network?.allowedDomains,
        ) ?? [],
        globalConfig.grants?.domains,
        projectConfig.grants?.domains,
        "domains",
      ),
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
      allowRead: mergeGrantArray(
        mergeConfiguredArray(
          defaults.filesystem?.allowRead,
          globalConfig.filesystem?.allowRead,
          projectConfig.filesystem?.allowRead,
        ) ?? [],
        globalConfig.grants?.readPaths,
        projectConfig.grants?.readPaths,
        "readPaths",
      ),
      allowWrite: mergeGrantArray(
        mergeConfiguredArray(
          defaults.filesystem?.allowWrite,
          globalConfig.filesystem?.allowWrite,
          projectConfig.filesystem?.allowWrite,
        ) ?? [],
        globalConfig.grants?.writePaths,
        projectConfig.grants?.writePaths,
        "writePaths",
      ),
      denyWrite: mergeConfiguredArray(
        defaults.filesystem?.denyWrite,
        globalConfig.filesystem?.denyWrite,
        projectConfig.filesystem?.denyWrite,
      ) ?? [],
    },
  };
}

async function readJsonConfig(path: string): Promise<SandboxConfigFile> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("configuration must be a JSON object");
    }
    return parsed as SandboxConfigFile;
  } catch (error) {
    throw new Error(
      `could not read sandbox configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}


export function ensureGlobalConfigTemplate(): void {
  const { globalPath } = getConfigPaths("");
  if (!existsSync(globalPath)) {
    try {
      const templateData = {
        "//": "Global Oh My Pi Sandbox Configuration",
        "//_doc1": "These grants punch holes in the sandbox globally across all your projects.",
        "//_doc2": "If you are experiencing Git credential issues, uncomment the paths below.",
        "grants": {
          "//_read_doc": "Allow reading global credentials and configs inside the sandbox",
          "readPaths": [
            // "~/.gitconfig",
            // "~/.config/git",
            // "~/.npmrc",
            // "~/.ssh/config",
            // "~/.ssh/known_hosts"
          ],
          "//_write_doc": "Allow writing to specific global paths (use sparingly)",
          "writePaths": [],
          "//_domains_doc": "Allow network access to specific domains",
          "domains": []
        }
      };
      // JSON doesn't support comments, so we write a custom formatted string
      const jsonContent = `{
  "_comment_1": "Global Oh My Pi Sandbox Configuration",
  "_comment_2": "These grants punch holes in the sandbox globally across all your projects.",
  "_comment_3": "To allow reading global git credentials inside the sandbox, add '~/.gitconfig' and '~/.config/git' to readPaths.",
  "grants": {
    "readPaths": [],
    "writePaths": [],
    "domains": []
  }
}
`;
      writeFileSync(globalPath, jsonContent, "utf8");
    } catch (error) {
      // Ignore if we can't write it (e.g. read-only install)
    }
  }
}

export function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(process.env.PI_CODING_AGENT_DIR ?? getAgentDir(), "sandbox.json"),
    projectPath: join(cwd, ".omp", "sandbox.json"),
  };
}

const LEGACY_LINUX_DENY_WRITE = [".env", ".env.*", "*.pem", "*.key"];

function normalizeConfigFileForPlatform(
  config: SandboxConfigFile,
  platform: NodeJS.Platform = process.platform,
): SandboxConfigFile {
  const denyWrite = config.filesystem?.denyWrite;
  if (platform !== "linux"
    || denyWrite?.length !== LEGACY_LINUX_DENY_WRITE.length
    || !denyWrite.every((value, index) => value === LEGACY_LINUX_DENY_WRITE[index])) {
    return config;
  }
  return {
    ...config,
    filesystem: { ...config.filesystem, denyWrite: [".env"] },
  };
}

function validateConfig(config: SandboxConfig): SandboxConfig {
  const { enabled, permissionPromptTimeoutSeconds, ...runtimeConfig } = config;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("sandbox enabled must be a boolean");
  }
  if (permissionPromptTimeoutSeconds !== undefined
    && (typeof permissionPromptTimeoutSeconds !== "number"
      || !Number.isFinite(permissionPromptTimeoutSeconds)
      || permissionPromptTimeoutSeconds < 0)) {
    throw new Error("sandbox permissionPromptTimeoutSeconds must be a non-negative finite number");
  }
  const parsed = SandboxRuntimeConfigSchema.safeParse(runtimeConfig);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "configuration"}: ${issue.message}`).join("; ");
    throw new Error(`invalid sandbox configuration: ${issues}`);
  }
  return { ...parsed.data, enabled, permissionPromptTimeoutSeconds };
}

export async function loadConfig(cwd: string, includeProject = true): Promise<SandboxConfig> {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  const [globalConfig, projectConfig] = await Promise.all([
    readJsonConfig(globalPath),
    includeProject ? readJsonConfig(projectPath) : Promise.resolve({}),
  ]);
  return validateConfig(mergeConfigLayers(
    DEFAULT_CONFIG,
    normalizeConfigFileForPlatform(globalConfig),
    normalizeConfigFileForPlatform(projectConfig),
  ));
}

const saveQueues = new Map<string, Promise<void>>();

async function updateConfig(
  path: string,
  update: (config: SandboxConfigFile) => void,
): Promise<void> {
  const previous = saveQueues.get(path) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    const config = await readJsonConfig(path);
    update(config);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
  await updateConfig(path, (config) => {
    const key = kind === "domain" ? "domains" : kind === "read" ? "readPaths" : "writePaths";
    const raw = config.grants?.[key];
    const existing = stringArray(raw);
    if (raw !== undefined && existing === undefined) {
      throw new Error(`sandbox grants.${key} must be an array of strings`);
    }
    config.grants = {
      ...config.grants,
      [key]: [...new Set([...(existing ?? []), value])],
    };
  });
}

export const addDomainToConfig = (path: string, value: string) =>
  addUniqueRule(path, "domain", value);
export const addReadPathToConfig = (path: string, value: string) =>
  addUniqueRule(path, "read", value);
export const addWritePathToConfig = (path: string, value: string) =>
  addUniqueRule(path, "write", value);
