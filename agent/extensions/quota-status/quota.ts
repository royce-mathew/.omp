export interface QuotaWindow {
  id: string;
  label: string;
  remainingPercent: number;
  resetsAt?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function percentRemaining(used: unknown): number | undefined {
  const parsed = number(used);
  return parsed === undefined ? undefined : Math.max(0, Math.min(100, 100 - parsed));
}

function resetTimestamp(window: Record<string, unknown>, now: number): number | undefined {
  const resetValue = window.reset_at ?? window.resetAt ?? window.resets_at ?? window.resetsAt;
  const raw = number(resetValue);
  if (raw !== undefined) return raw > 1_000_000_000_000 ? raw : raw * 1000;
  if (typeof resetValue === "string") {
    const parsed = Date.parse(resetValue);
    if (Number.isFinite(parsed)) return parsed;
  }
  const after = number(window.reset_after_seconds ?? window.resetAfterSeconds);
  return after === undefined ? undefined : now + after * 1000;
}

function subscriptionWindow(
  id: string,
  label: string,
  value: unknown,
  usageField: "used_percent" | "utilization",
  now: number,
): QuotaWindow | undefined {
  const window = record(value);
  if (!window) return undefined;
  const remainingPercent = percentRemaining(window[usageField] ?? window.usedPercent ?? window.used);
  if (remainingPercent === undefined) return undefined;
  return { id, label, remainingPercent, resetsAt: resetTimestamp(window, now) };
}

function codexWindow(value: unknown, fallbackId: string, fallbackLabel: string, now: number): QuotaWindow | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const durationSeconds = number(raw.limit_window_seconds ?? raw.limitWindowSeconds);
  const durationHours = durationSeconds === undefined ? undefined : durationSeconds / 3600;
  const isWeekly = durationHours !== undefined && durationHours >= 24 * 6;
  const id = isWeekly ? "weekly" : durationHours !== undefined ? `${Math.round(durationHours)}h` : fallbackId;
  const label = isWeekly ? "Wk" : durationHours !== undefined ? `${Math.round(durationHours)}h` : fallbackLabel;
  return subscriptionWindow(id, label, raw, "used_percent", now);
}

export function parseCodexQuota(value: unknown, now = Date.now()): QuotaWindow[] {
  const root = record(value);
  const rateLimit = record(root?.rate_limit ?? root?.rateLimit);
  if (!rateLimit) return [];
  return [
    codexWindow(rateLimit.primary_window ?? rateLimit.primaryWindow, "5h", "5h", now),
    codexWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow, "weekly", "Wk", now),
  ].filter((window): window is QuotaWindow => window !== undefined)
    .sort((left, right) => left.id === "weekly" ? 1 : right.id === "weekly" ? -1 : 0);
}

export function parseClaudeQuota(value: unknown, now = Date.now()): QuotaWindow[] {
  const root = record(value);
  if (!root) return [];
  return [
    subscriptionWindow("5h", "5h", root.five_hour, "utilization", now),
    subscriptionWindow("weekly", "Wk", root.seven_day, "utilization", now),
  ].filter((window): window is QuotaWindow => window !== undefined);
}

export function parseCopilotQuota(value: unknown): QuotaWindow[] {
  const root = record(value);
  const snapshots = record(root?.quota_snapshots);
  const premium = record(snapshots?.premium_interactions);
  const remaining = number(premium?.percent_remaining);
  if (remaining === undefined) return [];
  const reset = typeof root?.quota_reset_date === "string" ? Date.parse(root.quota_reset_date) : Number.NaN;
  return [{
    id: "monthly",
    label: "Mo",
    remainingPercent: Math.max(0, Math.min(100, remaining)),
    resetsAt: Number.isFinite(reset) ? reset : undefined,
  }];
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    return record(JSON.parse(Buffer.from(padded, "base64").toString("utf8")));
  } catch {
    return undefined;
  }
}

export function codexAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = record(payload?.["https://api.openai.com/auth"]);
  const id = auth?.chatgpt_account_id ?? auth?.account_id ?? payload?.chatgpt_account_id;
  return typeof id === "string" && id ? id : undefined;
}

export function parseQuotaHeaders(provider: string, headers: Record<string, string>): QuotaWindow[] {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (provider === "openai-codex") {
    const windows = [
      ["5h", "5h", "primary"],
      ["weekly", "Wk", "secondary"],
    ] as const;
    return windows.flatMap(([id, label, name]) => {
      const used = number(normalized[`x-codex-${name}-used-percent`]);
      if (used === undefined) return [];
      const reset = number(normalized[`x-codex-${name}-reset-at`]);
      const windowMinutes = number(normalized[`x-codex-${name}-window-minutes`]);
      const weekly = windowMinutes !== undefined && windowMinutes >= 60 * 24 * 6;
      return [{
        id: weekly ? "weekly" : id,
        label: weekly ? "Wk" : label,
        remainingPercent: Math.max(0, Math.min(100, 100 - used)),
        resetsAt: reset === undefined ? undefined : reset * 1000,
      }];
    });
  }
  if (provider === "anthropic") {
    const windows = [
      ["5h", "5h", "5h"],
      ["weekly", "Wk", "7d"],
    ] as const;
    return windows.flatMap(([id, label, name]) => {
      const prefix = `anthropic-ratelimit-unified-${name}-`;
      const utilization = number(normalized[`${prefix}utilization`]);
      if (utilization === undefined) return [];
      const reset = number(normalized[`${prefix}reset`]);
      return [{
        id,
        label,
        remainingPercent: Math.max(0, Math.min(100, 100 - utilization * 100)),
        resetsAt: reset === undefined ? undefined : reset * 1000,
      }];
    });
  }
  return [];
}

export function formatResetTime(resetsAt: number | undefined, now = Date.now()): string | undefined {
  if (resetsAt === undefined) return undefined;
  if (resetsAt <= now) return "now";
  const reset = new Date(resetsAt);
  const current = new Date(now);
  const time = reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (reset.toDateString() === current.toDateString()) return `today at ${time}`;
  const tomorrow = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
  if (reset.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  const date = reset.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${date} at ${time}`;
}

function quotaLabel(window: QuotaWindow): string {
  if (window.id === "weekly") return "Weekly";
  if (window.id === "monthly") return "Monthly";
  if (/^\d+h$/.test(window.id)) return `${window.id.slice(0, -1)}-hour`;
  return window.label;
}

export function formatQuota(windows: readonly QuotaWindow[], now = Date.now()): string {
  return windows.map((window) => {
    const reset = formatResetTime(window.resetsAt, now);
    return `${quotaLabel(window)}: ${Math.floor(window.remainingPercent)}% remaining${reset ? ` · resets ${reset}` : ""}`;
  }).join("  •  ");
}
