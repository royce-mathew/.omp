import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  codexAccountId,
  formatQuota,
  parseClaudeQuota,
  parseCodexQuota,
  parseCopilotQuota,
  parseQuotaHeaders,
  type QuotaWindow,
} from "./quota.ts";

const QUOTA_UPDATE_EVENT = "workspace-ui:quota";
const REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SUPPORTED_PROVIDERS: Record<string, true> = {
  "openai-codex": true,
  anthropic: true,
  "github-copilot": true,
};

interface ActiveQuota {
  provider: string;
  model: string;
  windows: QuotaWindow[];
  updatedAt: number;
}

function activeRef(ctx: ExtensionContext): { provider: string; model: string } | undefined {
  const model = ctx.model;
  if (!model || !SUPPORTED_PROVIDERS[model.provider]) return undefined;
  try {
    if (!ctx.modelRegistry.isUsingOAuth(model)) return undefined;
  } catch {
    return undefined;
  }
  return { provider: model.provider, model: model.id };
}

async function fetchJson(url: string, headers: Record<string, string>, parentSignal: AbortSignal): Promise<unknown> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new Error(`quota request failed: ${response.status}`);
  return response.json();
}

function unwrapCopilotToken(value: string): string {
  try {
    const parsed = JSON.parse(value) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : value;
  } catch {
    return value;
  }
}

async function fetchQuota(ctx: ExtensionContext, provider: string, signal: AbortSignal): Promise<QuotaWindow[]> {
  const token = await ctx.modelRegistry.getApiKeyForProvider(provider);
  if (!token) return [];
  if (provider === "openai-codex") {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const accountId = codexAccountId(token);
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    return parseCodexQuota(await fetchJson("https://chatgpt.com/backend-api/wham/usage", headers, signal));
  }
  if (provider === "anthropic") {
    return parseClaudeQuota(await fetchJson("https://api.anthropic.com/api/oauth/usage", {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    }, signal));
  }
  const accessToken = unwrapCopilotToken(token);
  return parseCopilotQuota(await fetchJson("https://api.github.com/copilot_internal/user", {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "pi-quota-status",
  }, signal));
}

export default function quotaStatus(pi: ExtensionAPI) {
  let active: ActiveQuota | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;

  const updateStatus = (ctx: ExtensionContext) => {
    const ref = activeRef(ctx);
    const selected = ref && active?.provider === ref.provider && active.model === ref.model ? active : undefined;
    pi.events.emit(QUOTA_UPDATE_EVENT, selected && selected.windows.length > 0
      ? {
          text: formatQuota(selected.windows),
          remainingPercent: Math.min(...selected.windows.map((window) => window.remainingPercent)),
        }
      : { text: null });
  };

  const refresh = async (ctx: ExtensionContext, candidateGeneration: number) => {
    const ref = activeRef(ctx);
    if (!ref) {
      active = undefined;
      updateStatus(ctx);
      return;
    }
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    try {
      const windows = await fetchQuota(ctx, ref.provider, requestController.signal);
      if (candidateGeneration !== generation) return;
      if (windows.length > 0) active = { ...ref, windows, updatedAt: Date.now() };
    } catch {
      if (candidateGeneration !== generation) return;
    } finally {
      if (controller === requestController) controller = undefined;
    }
    updateStatus(ctx);
  };

  const startPolling = (ctx: ExtensionContext) => {
    if (timer) clearInterval(timer);
    const candidateGeneration = generation;
    void refresh(ctx, candidateGeneration);
    timer = setInterval(() => void refresh(ctx, candidateGeneration), REFRESH_INTERVAL_MS);
    timer.unref?.();
  };

  pi.on("session_start", (_event, ctx) => {
    generation++;
    startPolling(ctx);
  });


  pi.on("after_provider_response", (event, ctx) => {
    const ref = activeRef(ctx);
    if (!ref) return;
    const windows = parseQuotaHeaders(ref.provider, event.headers);
    if (windows.length === 0) return;
    active = { ...ref, windows, updatedAt: Date.now() };
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    controller?.abort();
    controller = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
    active = undefined;
    pi.events.emit(QUOTA_UPDATE_EVENT, { text: null });
  });

  pi.registerCommand("quota", {
    description: "Show active provider quota and reset times",
    handler: async (_args, ctx) => {
      const ref = activeRef(ctx);
      if (!ref) {
        ctx.ui.notify("Quota is available for OAuth Codex, Claude, and GitHub Copilot models.", "info");
        return;
      }
      await refresh(ctx, generation);
      if (!active || active.windows.length === 0) {
        ctx.ui.notify(`${ref.provider}: quota unavailable`, "warning");
        return;
      }
      ctx.ui.notify(`${ref.provider}: ${formatQuota(active.windows)}`, "info");
    },
  });
}
