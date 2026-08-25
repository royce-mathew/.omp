import { describe, expect, test } from "bun:test";
import {
  formatQuota,
  parseClaudeQuota,
  parseCodexQuota,
  parseCopilotQuota,
  parseQuotaHeaders,
} from "../quota.ts";

describe("provider quota parsing", () => {
  test("parses Codex subscription windows", () => {
    const windows = parseCodexQuota({
      rate_limit: {
        primary_window: { used_percent: 22, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
        secondary_window: { used_percent: 70, limit_window_seconds: 604_800, reset_after_seconds: 3600 },
      },
    }, 1_000_000);
    expect(windows.map(({ label, remainingPercent }) => [label, remainingPercent])).toEqual([
      ["5h", 78], ["Wk", 30],
    ]);
    expect(windows[1]?.resetsAt).toBe(4_600_000);
  });

  test("uses the reported Codex duration instead of assuming primary means 5h", () => {
    const [window] = parseCodexQuota({
      rate_limit: { primary_window: { used_percent: 57, limit_window_seconds: 604_800, reset_at: 1_787_893_718 } },
    });
    expect(window).toMatchObject({ id: "weekly", label: "Wk", remainingPercent: 43 });
  });

  test("parses Claude and Copilot subscription payloads", () => {
    expect(parseClaudeQuota({
      five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00Z" },
      seven_day: { utilization: 40 },
    }).map((window) => window.remainingPercent)).toEqual([88, 60]);
    expect(parseCopilotQuota({
      quota_reset_date: "2030-02-01T00:00:00Z",
      quota_snapshots: { premium_interactions: { percent_remaining: 67 } },
    })[0]).toMatchObject({ label: "Mo", remainingPercent: 67 });
  });

  test("parses provider response headers and formats compact status", () => {
    const windows = parseQuotaHeaders("openai-codex", {
      "x-codex-primary-used-percent": "25",
      "x-codex-primary-reset-at": "2000000000",
    });
    expect(windows[0]).toMatchObject({ label: "5h", remainingPercent: 75, resetsAt: 2_000_000_000_000 });
    expect(formatQuota(windows, 1_999_999_000_000)).toContain("5-hour: 75% remaining · resets");
  });
});
