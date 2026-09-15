/**
 * ThreadBootstrap - Bootstrapped `thread.turn.start` dispatch.
 *
 * A turn start may carry a `bootstrap` block that has to create the thread,
 * prepare a git worktree for it, and run the project's setup script before
 * the turn itself can start. That sequence owns rollback, cancellation and
 * the worktree setup card, so it lives behind this service rather than in a
 * transport. The WebSocket handler and the MCP thread toolkit both call it.
 *
 * @module ThreadBootstrap
 */
import type {
  OrchestrationClientOrigin,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

export interface ThreadBootstrapDispatchOptions {
  /**
   * Attributed to every command the bootstrap emits. Connections pass their
   * client; server-side callers such as the MCP toolkit leave it unset.
   */
  readonly origin?: OrchestrationClientOrigin;
}

/**
 * ThreadBootstrapShape - Service API for bootstrapped turn starts.
 */
export interface ThreadBootstrapShape {
  /**
   * Runs the command's `bootstrap` block, then dispatches the turn start
   * without it. Callers that hold a command with no `bootstrap` should
   * dispatch it through `OrchestrationEngine` directly.
   *
   * A bootstrap that prepares a worktree runs on a detached fiber, so it
   * outlives the caller: a dropped connection must not abandon a half-made
   * worktree. The returned effect waits on that fiber. Interrupting the wait
   * does not cancel the bootstrap; cancellation goes through
   * `WorktreeSetupTracker`.
   */
  readonly dispatchTurnStart: (
    command: ThreadTurnStartCommand,
    options?: ThreadBootstrapDispatchOptions,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

/**
 * ThreadBootstrap - Service tag for bootstrapped turn starts.
 */
export class ThreadBootstrap extends Context.Service<ThreadBootstrap, ThreadBootstrapShape>()(
  "t3/orchestration/Services/ThreadBootstrap",
) {}
