# Undo-Redo Extension

This extension manages the `v2` undo/redo state machine and atomic Git snapshotting for Oh My Pi. 

It is designed to operate safely in an asynchronous, crash-prone environment where human developers and background subagents are concurrently modifying the workspace.

## Architecture

The extension is split across three core domains:

### 1. Persistent State Model (`state.ts`)
Rather than relying on mutable `undo[]` and `redo[]` arrays in memory (which are vulnerable to data loss during process crashes), history is tracked via an **append-only event stream**:
* **Checkpoints (`omp.undo-redo.checkpoint.v2`):** Recorded exactly once when a parent turn finishes. They contain the before/after Git hashes (`indexTree`, `worktreeTree`) and an explicit array of `changedPaths`.
* **Cursors (`omp.undo-redo.cursor.v2`):** Executing `/undo` appends a Cursor event rather than deleting a Checkpoint. 
* **Reconstruction:** On boot, `reconstructState()` reads the stream to rebuild the active branch, evaluate the redo stack, and assert the expected sticky Git `HEAD`s.

### 2. Path-Selective Restoration (`git.ts`)
To prevent `/undo` from destroying independent manual edits the user made while an agent was running, the extension rejects whole-workspace rollbacks (e.g., `git reset`).
* **Capture:** Generates `changedPaths` by diffing the before and after trees.
* **Compare (`matchPaths`):** Pre-validates *only* the affected files. Unrelated manual edits are safely ignored. Overlapping edits on a `changedPath` file will safely block the undo to prevent data loss.
* **Restore (`restorePaths`):** Loads the target history into a private temporary index, checks out only the affected files, and cleans up.

### 3. Transaction Safety (`index.ts`)
* **Crash Recovery:** Mutating history requires moving the transcript cursor *and* modifying the disk. To prevent split-brain states if power is lost midway, an atomic `TransitionJournal` tracks the exact phase (`prepared` → `transcript-moved` → `workspace-restored`). A transient rollback snapshot is captured beforehand to guarantee clean recovery.
* **Subagent Gating:** The orchestrator checks the `AgentRegistry` before executing an undo. If a relevant descendant subagent is currently running, the command is strictly blocked.

## Storage and Retention

The extension utilizes two storage locations with strict bounding limits to prevent out-of-memory errors and disk bloat:

* **The Ledger (`.data/`):** The catalog tracking checkpoint metadata is stored **globally** relative to the extension source code (`import.meta.dir + "/.data"`), ensuring user project folders are not polluted with Oh My Pi metadata.
* **The Snapshots (`.git/`):** The actual file blobs are stored as private/unlinked Git refs inside the local project's repository, leveraging Git's native compression while remaining invisible to standard commands like `git log`.

**Garbage Collection Caps:**
A cross-process GC runs automatically with the following strict limits:
* `MAX_UNTRACKED_FILE_BYTES`: Ignores untracked files over `2MB`.
* `MAX_TURN_PRIVATE_BYTES`: Safely rejects Checkpoint capture if a single turn generates over `32MB` of changes.
* `MAX_TURNS_PER_ROOT_SESSION`: Retains the newest `100` turns per session.
* `MAX_SNAPSHOT_AGE_MS`: Expires Checkpoints older than `30 days`.
* `MAX_DATA_BYTES`: Hard project limit of `1GB`. Once hit, old checkpoints remain usable, but new captures are safely rejected until space is cleared.
