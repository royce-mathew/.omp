import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
  CHECKPOINT_TYPE,
  CURSOR_TYPE,
  loadPosition,
  reconstructState,
  UNAVAILABLE_TYPE,
  type TurnCheckpoint,
} from "../state.ts";
function checkpoint(id: string): TurnCheckpoint {
  const snapshot = {
    repositoryRoot: "/workspace",
    commonDir: "/workspace/.git",
    head: "a".repeat(40),
    indexTree: "b".repeat(40),
    worktreeTree: "c".repeat(40),
    refName: `refs/omp/undo/main/${id}/after/root`,
    scopes: ["."],
    excludedPaths: [],
  };
  return {
    
    id,
    rootSessionId: "main",
    userEntryId: `user-${id}`,
    sessionFile: "/sessions/source.jsonl",
    sessionId: "source",
    createdAt: "2026-08-26T00:00:00.000Z",
    workspaces: [
      {
        repositoryRoot: snapshot.repositoryRoot,
        commonDir: snapshot.commonDir,
        before: snapshot,
        after: snapshot,
        changedPaths: ["tracked.txt"],
      },
    ],
  };
}

function custom(
  id: string,
  customType: string,
  data: unknown,
  parentId: string | null = null,
): SessionEntry {
  return {
    id,
    parentId,
    type: "custom",
    timestamp: "2026-08-26T00:00:00.000Z",
    customType,
    data,
  } as unknown as SessionEntry;
}

describe("undo state reconstruction", () => {
  it("reconstructs redo from its exact source position", async () => {
    const first = checkpoint("first");
    const source = [custom("checkpoint", CHECKPOINT_TYPE, first)];
    const state = await reconstructState(
      [
        custom("cursor", CURSOR_TYPE, {
          
          kind: "undo",
          turnId: first.id,
          source: { sessionFile: "/sessions/source.jsonl", leafId: "checkpoint" },
        }),
      ],
      async () => source,
    );

    expect(state.applied).toEqual([]);
    expect(state.redo.map(({ turn }) => turn.id)).toEqual(["first"]);
    expect(state.redo[0]?.target).toEqual({
      sessionFile: "/sessions/source.jsonl",
      leafId: "checkpoint",
    });
  });

  it("rejects a cursor targeting another turn", async () => {
    const first = checkpoint("first");
    const source = [custom("checkpoint", CHECKPOINT_TYPE, first)];
    const ignored = await reconstructState([
      custom("legacy", "omp.undo-redo.state", {  undo: [first], redo: [] }),
    ]);
    expect(ignored.applied).toEqual([]);

    await expect(
      reconstructState(
        [
          custom("cursor", CURSOR_TYPE, {
            
            kind: "undo",
            turnId: "other",
            source: { sessionFile: "/sessions/source.jsonl", leafId: "checkpoint" },
          }),
        ],
        async () => source,
      ),
    ).rejects.toThrow("does not target the final applied turn");
  });

  it("orders one, two, and three nested undos as a LIFO redo stack", async () => {
    const first = checkpoint("first");
    const second = checkpoint("second");
    const third = checkpoint("third");
    const base = [
      custom("first", CHECKPOINT_TYPE, first),
      custom("second", CHECKPOINT_TYPE, second, "first"),
      custom("third", CHECKPOINT_TYPE, third, "second"),
    ];
    const firstUndo = [
      custom("undo-third", CURSOR_TYPE, {
        
        kind: "undo",
        turnId: third.id,
        source: { sessionFile: "/sessions/base.jsonl", leafId: "third" },
      }),
    ];
    const secondUndo = [
      custom("undo-second", CURSOR_TYPE, {
        
        kind: "undo",
        turnId: second.id,
        source: { sessionFile: "/sessions/undo-third.jsonl", leafId: "undo-third" },
      }),
    ];
    const state = await reconstructState(
      [
        custom("undo-first", CURSOR_TYPE, {
          
          kind: "undo",
          turnId: first.id,
          source: { sessionFile: "/sessions/undo-second.jsonl", leafId: "undo-second" },
        }),
      ],
      async ({ sessionFile }) => {
        if (sessionFile.endsWith("base.jsonl")) return base;
        if (sessionFile.endsWith("undo-third.jsonl")) return firstUndo;
        if (sessionFile.endsWith("undo-second.jsonl")) return secondUndo;
        throw new Error(`Unexpected source: ${sessionFile}`);
      },
    );

    expect(state.applied).toEqual([]);
    expect(state.redo.map(({ turn }) => turn.id)).toEqual([
      "third",
      "second",
      "first",
    ]);
    expect(state.redo.at(-1)?.target).toEqual({
      sessionFile: "/sessions/undo-second.jsonl",
      leafId: "undo-second",
    });
  });

  it("clears redo when a new checkpoint follows a truncate cursor", async () => {
    const first = checkpoint("first");
    const second = checkpoint("second");
    const replacement = checkpoint("replacement");
    const source = [
      custom("first", CHECKPOINT_TYPE, first),
      custom("second", CHECKPOINT_TYPE, second, "first"),
    ];
    const state = await reconstructState(
      [
        custom("undo-second", CURSOR_TYPE, {
          
          kind: "undo",
          turnId: second.id,
          source: { sessionFile: "/sessions/source.jsonl", leafId: "second" },
        }),
        custom("truncate", CURSOR_TYPE, {  kind: "truncate" }, "undo-second"),
        custom("replacement", CHECKPOINT_TYPE, replacement, "truncate"),
      ],
      async () => source,
    );

    expect(state.applied.map(({ id }) => id)).toEqual(["first", "replacement"]);
    expect(state.redo).toEqual([]);
  });

  it("fails closed for malformed events, nested cursor cycles, and missing sources", async () => {
    await expect(
      reconstructState([custom("bad-checkpoint", CHECKPOINT_TYPE, { version: 2 })]),
    ).rejects.toThrow("Malformed undo checkpoint");
    await expect(
      reconstructState([custom("bad-cursor", CURSOR_TYPE, {  kind: "redo" })]),
    ).rejects.toThrow("Malformed undo cursor");

    const cyclic = custom("cycle", CURSOR_TYPE, {
      
      kind: "undo",
      turnId: "turn",
      source: { sessionFile: "/sessions/cycle.jsonl", leafId: "cycle" },
    });
    await expect(
      reconstructState([cyclic], async () => [cyclic]),
    ).rejects.toThrow("Undo cursor cycle");

    await expect(
      loadPosition({ sessionFile: "/missing/undo-redo-session.jsonl", leafId: null }),
    ).rejects.toThrow("Persisted session is missing");
  });

  it("fails closed when a persisted position names a missing leaf", async () => {
    const root = await fs.mkdtemp("/tmp/omp-undo-redo-state-");
    const sessions = path.join(root, "sessions");
    try {
      const manager = SessionManager.create(root, sessions);
      manager.appendMessage({
        role: "user",
        content: "persisted",
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "persisted" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      await manager.flush();
      const sessionFile = manager.getSessionFile();
      expect(sessionFile).toBeDefined();
      await expect(
        loadPosition({ sessionFile: sessionFile!, leafId: "missing-leaf" }),
      ).rejects.toThrow("Missing session leaf");
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("treats an unavailable capture as a hard history barrier", async () => {
    const state = await reconstructState([
      custom("unavailable", UNAVAILABLE_TYPE, {  reason: "snapshot limit" }),
    ]);
    expect(state.barrier).toBe(true);
    expect(state.applied).toEqual([]);
  });
});
