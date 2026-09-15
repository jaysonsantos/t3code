import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { ThreadBootstrap } from "../../../orchestration/Services/ThreadBootstrap.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ServerSettings.ServerSettingsService,
  ThreadBootstrap,
];

/**
 * Spawns allowed per turn of the calling thread. One user instruction that
 * fans out to "work on a, b and c" needs a handful; a runaway loop must not
 * fill the sidebar. The count resets when the calling thread starts its next
 * turn, so a long thread is never permanently capped.
 */
export const THREAD_SPAWN_LIMIT_PER_TURN = 10;

export const ThreadWorkspaceMode = Schema.Literals(["worktree", "local"]);
export type ThreadWorkspaceMode = typeof ThreadWorkspaceMode.Type;

export const CreateThreadInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "The instruction the new thread starts with. Write it as a standalone task: the new thread does not inherit this conversation's history, so restate the context it needs.",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Short title for the thread's sidebar row. Defaults to the opening words of the prompt.",
    }),
  ),
  workspace: Schema.optional(
    ThreadWorkspaceMode.annotate({
      description:
        "Where the new thread works. 'worktree' (the default) gives it an isolated git worktree on a new branch, so parallel threads cannot collide. Use 'local' only when the task must run in the project checkout itself.",
    }),
  ),
});
export type CreateThreadInput = typeof CreateThreadInput.Type;

export class ThreadSpawnLimitReachedError extends Schema.TaggedError<ThreadSpawnLimitReachedError>()(
  "ThreadSpawnLimitReachedError",
  { limit: Schema.Int },
) {
  override get message(): string {
    return `This turn already started ${this.limit} threads, which is the limit. Do the remaining work here, or ask the user to split it across turns.`;
  }
}

export class ThreadSpawnParentNotFoundError extends Schema.TaggedError<ThreadSpawnParentNotFoundError>()(
  "ThreadSpawnParentNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found, so its project and model could not be read.`;
  }
}

export class ThreadSpawnProjectNotFoundError extends Schema.TaggedError<ThreadSpawnProjectNotFoundError>()(
  "ThreadSpawnProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found, so the new thread has no workspace to run in.`;
  }
}

export class ThreadSpawnFailedError extends Schema.TaggedError<ThreadSpawnFailedError>()(
  "ThreadSpawnFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not start the new thread.";
  }
}

export const ThreadToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadSpawnLimitReachedError,
  ThreadSpawnParentNotFoundError,
  ThreadSpawnProjectNotFoundError,
  ThreadSpawnFailedError,
]);
export type ThreadToolError = typeof ThreadToolError.Type;

export const CreateThreadResult = Schema.Struct({
  threadId: Schema.String.annotate({
    description: "The new thread's id. Quote it when you report the split to the user.",
  }),
  title: Schema.String,
  workspace: ThreadWorkspaceMode,
  branch: Schema.NullOr(Schema.String).annotate({
    description:
      "The branch the new worktree is being created on, or null when the thread runs in the project checkout.",
  }),
  remainingThisTurn: Schema.Int.annotate({
    description: "How many more threads this turn may start.",
  }),
});
export type CreateThreadResult = typeof CreateThreadResult.Type;

const CreateThreadTool = Tool.make("create_thread", {
  description:
    "Start a separate T3 Code thread that works on its own task, in its own git worktree by default. Use it when the user asks for several independent pieces of work at once, so each gets a clean context and they progress in parallel. The new thread inherits this thread's project, model and permission mode, and appears in the user's sidebar beside this one. It starts working immediately; this call returns as soon as the thread exists and does not wait for its worktree or its answer, so you cannot read its result. Do not use it to break one task into steps you could do here.",
  parameters: CreateThreadInput,
  success: CreateThreadResult,
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a new thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(CreateThreadTool);
