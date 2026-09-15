import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ThreadBootstrap,
  type ThreadTurnStartCommand,
} from "../../../orchestration/Services/ThreadBootstrap.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit, THREAD_SPAWN_LIMIT_PER_TURN } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const INSTANCE_ID = ProviderInstanceId.make("codex");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: INSTANCE_ID,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const PROJECT: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Parent",
    modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/workspace/project-worktree",
    pullRequests: [],
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "running",
      requestedAt: "2026-08-20T00:00:00.000Z",
      startedAt: "2026-08-20T00:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

interface HarnessOptions {
  readonly thread?: OrchestrationThreadShell | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly settings?: ServerSettingsValue;
}

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const thread = yield* Ref.make(options.thread === undefined ? makeThread() : options.thread);
  const project = options.project === undefined ? PROJECT : options.project;
  // The handler forks the bootstrap, so the test waits on this queue rather
  // than on a timer: taking an entry is the receipt that the fork ran.
  const started = yield* Queue.unbounded<ThreadTurnStartCommand>();
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        threadId === THREAD_ID
          ? Effect.map(Ref.get(thread), Option.fromNullishOr)
          : Effect.succeedNone,
      getProjectShellById: () => Effect.succeed(Option.fromNullishOr(project)),
    }),
    Layer.mock(ThreadBootstrap)({
      dispatchTurnStart: (command) =>
        Queue.offer(started, command).pipe(Effect.as({ sequence: 1 })),
    }),
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed(options.settings ?? DEFAULT_SERVER_SETTINGS),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof ThreadsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["threads"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ThreadsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  const setThread = (next: OrchestrationThreadShell) => Ref.set(thread, next);
  return { call, started, setThread };
});

describe("threads toolkit handlers", () => {
  it.effect("refuses a credential without the threads capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("create_thread", { prompt: "do the thing" }, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error._tag).toBe("McpCapabilityUnavailableError");
    }),
  );

  it.effect("starts a worktree thread that inherits the parent's project and model", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("create_thread", {
        prompt: "Port the parser to the new API",
      });

      expect(result.workspace).toBe("worktree");
      expect(result.title).toBe("Port the parser to the new API");
      expect(result.remainingThisTurn).toBe(THREAD_SPAWN_LIMIT_PER_TURN - 1);
      expect(result.threadId).not.toBe(THREAD_ID);

      const command = yield* Queue.take(harness.started);
      expect(command.threadId).toBe(result.threadId);
      expect(command.message.text).toBe("Port the parser to the new API");
      expect(command.modelSelection).toEqual({ instanceId: INSTANCE_ID, model: "gpt-5" });
      expect(command.runtimeMode).toBe("full-access");
      expect(command.bootstrap?.createThread?.projectId).toBe(PROJECT_ID);
      // A worktree bootstrap leaves the path for the checkout to fill in.
      expect(command.bootstrap?.createThread?.worktreePath).toBeNull();
      expect(command.bootstrap?.prepareWorktree).toEqual({
        projectCwd: "/workspace/project",
        baseBranch: "main",
        branch: result.branch,
        // On by default, matching what the composer would have sent.
        startFromOrigin: true,
      });
      expect(command.bootstrap?.runSetupScript).toBe(true);
    }),
  );

  it.effect("cuts from the local base branch when the project default turns origin off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: { ...DEFAULT_SERVER_SETTINGS, newWorktreesStartFromOrigin: false },
      });
      yield* harness.call("create_thread", { prompt: "task" });
      const command = yield* Queue.take(harness.started);
      expect(command.bootstrap?.prepareWorktree?.startFromOrigin).toBeUndefined();
    }),
  );

  it.effect("runs in the project checkout when asked for a local workspace", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("create_thread", {
        prompt: "task",
        workspace: "local",
      });

      expect(result.workspace).toBe("local");
      expect(result.branch).toBeNull();
      const command = yield* Queue.take(harness.started);
      expect(command.bootstrap?.prepareWorktree).toBeUndefined();
      expect(command.bootstrap?.runSetupScript).toBeUndefined();
      expect(command.bootstrap?.createThread?.worktreePath).toBe("/workspace/project-worktree");
    }),
  );

  it.effect("falls back to local when the parent thread has no base branch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread({ branch: null, worktreePath: null }),
      });
      const result = yield* harness.call("create_thread", { prompt: "task" });

      expect(result.workspace).toBe("local");
      const command = yield* Queue.take(harness.started);
      expect(command.bootstrap?.prepareWorktree).toBeUndefined();
    }),
  );

  it.effect("shortens a long prompt into a title and keeps an explicit one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const long = yield* harness.call("create_thread", { prompt: "word ".repeat(40) });
      expect(long.title.length).toBeLessThanOrEqual(72);
      expect(long.title.endsWith("...")).toBe(true);

      const explicit = yield* harness.call("create_thread", {
        prompt: "a very long prompt that would otherwise become the title",
        title: "Parser port",
      });
      expect(explicit.title).toBe("Parser port");
    }),
  );

  it.effect("stops at the per-turn limit and resets on the parent's next turn", () =>
    Effect.gen(function* () {
      const thread = makeThread();
      const harness = yield* makeHarness({ thread });

      for (let index = 0; index < THREAD_SPAWN_LIMIT_PER_TURN; index += 1) {
        const result = yield* harness.call("create_thread", { prompt: `task ${index}` });
        expect(result.remainingThisTurn).toBe(THREAD_SPAWN_LIMIT_PER_TURN - index - 1);
      }

      const error = yield* harness
        .call("create_thread", { prompt: "one too many" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ThreadSpawnLimitReachedError");

      // The same parent on a later turn gets a fresh budget.
      yield* harness.setThread(
        makeThread({ latestTurn: { ...thread.latestTurn!, turnId: TurnId.make("turn-2") } }),
      );
      const afterNewTurn = yield* harness.call("create_thread", { prompt: "next turn task" });
      expect(afterNewTurn.remainingThisTurn).toBe(THREAD_SPAWN_LIMIT_PER_TURN - 1);
    }),
  );

  it.effect("reports a missing project instead of starting a thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ project: null });
      const error = yield* harness.call("create_thread", { prompt: "task" }).pipe(Effect.flip);
      expect(error._tag).toBe("ThreadSpawnProjectNotFoundError");
    }),
  );
});
