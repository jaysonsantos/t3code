import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrap } from "../../../orchestration/Services/ThreadBootstrap.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  CreateThreadInput,
  ThreadSpawnFailedError,
  ThreadSpawnLimitReachedError,
  ThreadSpawnParentNotFoundError,
  ThreadSpawnProjectNotFoundError,
  ThreadsToolkit,
  THREAD_SPAWN_LIMIT_PER_TURN,
  type ThreadWorkspaceMode,
} from "./tools.ts";

const TITLE_MAX_LENGTH = 72;

/** One entry per thread that has used the tool; the count resets on a new turn. */
interface SpawnBudget {
  readonly turnKey: string;
  readonly used: number;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The sidebar row needs a line, not a paragraph. Mirrors the clients' titles. */
function deriveTitleFromPrompt(prompt: string): string {
  const compact = prompt.trim().replace(/\s+/g, " ");
  if (compact.length === 0) return "New thread";
  return compact.length <= TITLE_MAX_LENGTH
    ? compact
    : `${compact.slice(0, TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

/**
 * A worktree thread records the branch it was cut from, so the new thread's
 * base is the parent's base rather than the parent's temporary branch.
 */
function baseBranchOf(parent: OrchestrationThreadShell): string | null {
  return parent.branch;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const threadBootstrap = yield* ThreadBootstrap;
  const budgets = yield* Ref.make(new Map<ThreadId, SpawnBudget>());

  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);

  const failed = <E>(cause: Cause.Cause<E>): Effect.Effect<never, ThreadSpawnFailedError> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new ThreadSpawnFailedError({ cause }));

  /**
   * Claims one spawn for the calling thread's current turn. A thread with no
   * turn yet shares a single key, so the cap still holds before the first
   * turn is projected.
   */
  const claimSpawn = (parent: OrchestrationThreadShell) => {
    const turnKey = parent.latestTurn?.turnId ?? "pending";
    return Ref.modify(budgets, (current) => {
      const existing = current.get(parent.id);
      const used = existing && existing.turnKey === turnKey ? existing.used : 0;
      if (used >= THREAD_SPAWN_LIMIT_PER_TURN) {
        return [Option.none<number>(), current] as const;
      }
      const next = new Map(current);
      next.set(parent.id, { turnKey, used: used + 1 });
      return [Option.some(THREAD_SPAWN_LIMIT_PER_TURN - used - 1), next] as const;
    }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new ThreadSpawnLimitReachedError({ limit: THREAD_SPAWN_LIMIT_PER_TURN })),
          onSome: Effect.succeed,
        }),
      ),
    );
  };

  const requireParent = Effect.fn("ThreadsToolkit.requireParent")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("threads");
    const parent = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.catchCause(failed));
    if (Option.isNone(parent)) {
      return yield* new ThreadSpawnParentNotFoundError({ threadId: scope.threadId });
    }
    return parent.value;
  });

  const requireProject = Effect.fn("ThreadsToolkit.requireProject")(function* (
    parent: OrchestrationThreadShell,
  ) {
    const project = yield* snapshots
      .getProjectShellById(parent.projectId)
      .pipe(Effect.catchCause(failed));
    if (Option.isNone(project)) {
      return yield* new ThreadSpawnProjectNotFoundError({ projectId: parent.projectId });
    }
    return project.value;
  });

  /**
   * The stored default for cutting new worktrees from the remote. Read per
   * project so the spawned thread matches what the composer would have done.
   */
  const startFromOrigin = (project: OrchestrationProjectShell) =>
    serverSettings.getSettings.pipe(
      Effect.map(
        (settings) =>
          resolveProjectSettings(settings, project.id).settings.newWorktreesStartFromOrigin ===
          true,
      ),
      // A settings read failure must not block the spawn; the conservative
      // default is the local base branch.
      Effect.catchCause(() => Effect.succeed(false)),
    );

  return ThreadsToolkit.of({
    create_thread: (input: CreateThreadInput) =>
      Effect.gen(function* () {
        const parent = yield* requireParent();
        const project = yield* requireProject(parent);
        const remainingThisTurn = yield* claimSpawn(parent);

        const workspace: ThreadWorkspaceMode = input.workspace ?? "worktree";
        const baseBranch = baseBranchOf(parent);
        // Worktree mode needs a base branch to cut from. Without one the
        // bootstrap would silently fall back to the project checkout, so say
        // so in the result instead of pretending the thread is isolated.
        const useWorktree = workspace === "worktree" && baseBranch !== null;
        const title = input.title ?? deriveTitleFromPrompt(input.prompt);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const threadId = ThreadId.make(yield* randomUUID);
        const worktreeBranch = useWorktree
          ? buildTemporaryWorktreeBranchName(
              (
                (bytes: Uint8Array) => () =>
                  bytesToHex(bytes)
              )(yield* crypto.randomBytes(4).pipe(Effect.orDie)),
            )
          : null;

        const command = {
          type: "thread.turn.start" as const,
          commandId: CommandId.make(`mcp-create-thread:${yield* randomUUID}`),
          threadId,
          message: {
            messageId: MessageId.make(yield* randomUUID),
            role: "user" as const,
            text: input.prompt,
            attachments: [],
          },
          modelSelection: parent.modelSelection,
          titleSeed: title,
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          bootstrap: {
            createThread: {
              projectId: parent.projectId,
              title,
              modelSelection: parent.modelSelection,
              runtimeMode: parent.runtimeMode,
              interactionMode: parent.interactionMode,
              branch: baseBranch,
              // The bootstrap fills this in once the checkout lands.
              worktreePath: useWorktree ? null : parent.worktreePath,
              createdAt,
            },
            ...(useWorktree && baseBranch !== null && worktreeBranch !== null
              ? {
                  prepareWorktree: {
                    projectCwd: project.workspaceRoot,
                    baseBranch,
                    branch: worktreeBranch,
                    ...((yield* startFromOrigin(project)) ? { startFromOrigin: true } : {}),
                  },
                  runSetupScript: true,
                }
              : {}),
          },
          createdAt,
        };

        // Checkout and setup script run for minutes on a large repository.
        // Detach so the calling agent keeps working: the thread is already
        // listed as starting on every client, and a failed bootstrap deletes
        // it again. Nothing here can report that failure back to the caller.
        yield* threadBootstrap
          .dispatchTurnStart(command)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

        return {
          threadId,
          title,
          workspace: useWorktree ? ("worktree" as const) : ("local" as const),
          branch: worktreeBranch,
          remainingThisTurn,
        };
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
