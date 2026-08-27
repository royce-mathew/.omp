import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
  CHECKPOINT_TYPE,
  CURSOR_TYPE,
  reconstructState,
  UNAVAILABLE_TYPE,
  type TurnCheckpointV2,
} from "../state.ts";
function checkpoint(id: string): TurnCheckpointV2 {
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
    version: 2,
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

function custom(id: string, customType: string, data: unknown): SessionEntry {
  return {
    id,
    parentId: null,
    type: "custom",
    timestamp: "2026-08-26T00:00:00.000Z",
    customType,
    data,
  } as unknown as SessionEntry;
}

describe("v2 undo state reconstruction", () => {
  it("reconstructs redo from its exact source position", async () => {
    const first = checkpoint("first");
    const source = [custom("checkpoint", CHECKPOINT_TYPE, first)];
    const state = await reconstructState(
      [
        custom("cursor", CURSOR_TYPE, {
          version: 2,
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

  it("ignores v1 records and rejects a cursor targeting another turn", async () => {
    const first = checkpoint("first");
    const source = [custom("checkpoint", CHECKPOINT_TYPE, first)];
    const ignored = await reconstructState([
      custom("legacy", "omp.undo-redo.state", { version: 1, undo: [first], redo: [] }),
    ]);
    expect(ignored.applied).toEqual([]);

    await expect(
      reconstructState(
        [
          custom("cursor", CURSOR_TYPE, {
            version: 2,
            kind: "undo",
            turnId: "other",
            source: { sessionFile: "/sessions/source.jsonl", leafId: "checkpoint" },
          }),
        ],
        async () => source,
      ),
    ).rejects.toThrow("does not target the final applied turn");
  });

  it("treats an unavailable capture as a hard history barrier", async () => {
    const state = await reconstructState([
      custom("unavailable", UNAVAILABLE_TYPE, { version: 2, reason: "snapshot limit" }),
    ]);
    expect(state.barrier).toBe(true);
    expect(state.applied).toEqual([]);
  });
});
