/**
 * Follows one agent run until it ends (docs/AGENTS.md sections 6 and 7). Without the live stream it long-polls
 * `GET /v1/agent-runs/:id?wait=25` and reads new steps with `GET /v1/agent-runs/:id/events?after=<seq>`; once the stream
 * proves it carries this run's updates, each stream event nudges an immediate read and polling drops to a slow safety
 * check. Everything stops on a terminal state, after one last read of the steps so the final one is not missed.
 * Free of React so the loop is unit tested with a scripted API.
 */
import { ApiError } from "./http";
import { lastSeq, mergeEvents, pollPlan } from "./agents";
import type { AgentsApi } from "./agents-api";
import type { AgentRun, AgentRunEvent } from "./schemas";

export type FollowState = {
  run: AgentRun | null;
  events: AgentRunEvent[];
  /** The last read failed; reads keep retrying until the run ends or is not found. */
  error: unknown | null;
  /** Terminal state reached (or the run does not exist): nothing polls any more. */
  done: boolean;
};

export type FollowerOptions = {
  /** Trust the live stream from the start (tests); otherwise it must first deliver an update for this run. */
  live?: boolean;
  /** Scales every pause; tests pass `() => 0`. */
  delay?: (ms: number) => number;
};

const RETRY_MS = 3_000;

export class RunFollower {
  private state: FollowState = { run: null, events: [], error: null, done: false };
  private readonly listeners = new Set<(s: FollowState) => void>();
  private readonly abort = new AbortController();
  private readonly wakers = new Set<() => void>();
  private live: boolean;
  private streamUp: boolean;
  private proven: boolean;
  private readonly delay: (ms: number) => number;
  private started = false;

  constructor(
    private readonly id: string,
    private readonly api: Pick<AgentsApi, "run" | "runEvents">,
    opts: FollowerOptions = {},
  ) {
    this.live = opts.live ?? false;
    this.streamUp = this.live;
    this.proven = this.live;
    this.delay = opts.delay ?? ((ms) => ms);
  }

  get snapshot(): FollowState {
    return this.state;
  }

  get stopped(): boolean {
    return this.abort.signal.aborted || this.state.done;
  }

  subscribe(fn: (s: FollowState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  /** The live stream connected or dropped. It counts only once it has carried an update for this run. */
  setStream(up: boolean): void {
    this.streamUp = up;
    this.updateLive();
  }

  /** The stream delivered an update for this run: it is trusted from now on, and the run is read at once. */
  streamEvent(): void {
    this.proven = true;
    this.updateLive();
    this.nudge();
  }

  /** A stream event or an action (cancel) says the run changed: read it and its new steps now. */
  nudge(): void {
    if (this.stopped) return;
    this.wakeAll();
    void this.readRun();
    void this.readEvents();
  }

  /** A run this screen already holds (from cancel or start), so the status shows before the next read. */
  adopt(run: AgentRun): void {
    if (run.id !== this.id) return;
    this.set({ run, error: null });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await Promise.all([this.readRun(), this.readEvents()]);
    if (this.stopped) return;
    void this.statusLoop();
    void this.eventsLoop();
  }

  stop(): void {
    this.abort.abort();
    this.wakeAll();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------

  private set(patch: Partial<FollowState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private updateLive() {
    const live = this.proven && this.streamUp;
    if (live === this.live) return;
    this.live = live;
    this.wakeAll();
  }

  private wakeAll() {
    for (const w of [...this.wakers]) w();
    this.wakers.clear();
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, this.delay(ms));
      this.wakers.add(done);
    });
  }

  private plan() {
    return pollPlan(this.state.run, this.live);
  }

  /** A read failed: a missing run ends following; anything else is shown and retried. */
  private failed(e: unknown): boolean {
    if (this.abort.signal.aborted) return true;
    if (e instanceof ApiError && e.status === 404) {
      this.set({ error: e, done: true });
      return true;
    }
    this.set({ error: e });
    return false;
  }

  private applyRun(run: AgentRun) {
    if (this.abort.signal.aborted) return;
    const ended = this.plan().stop === false && pollPlan(run, this.live).stop;
    this.set({ run, error: null });
    // The final step can land just before the terminal status is read; one more read of the steps catches it.
    if (ended) void this.readEvents().then(() => this.set({ done: true }));
  }

  private async readRun(wait = 0): Promise<boolean> {
    try {
      const run = await this.api.run(this.id, wait, { signal: this.abort.signal });
      this.applyRun(run);
      return true;
    } catch (e) {
      this.failed(e);
      return false;
    }
  }

  private async readEvents(): Promise<boolean> {
    try {
      const after = lastSeq(this.state.events);
      const next = await this.api.runEvents(this.id, after, { signal: this.abort.signal });
      if (this.abort.signal.aborted) return false;
      const events = mergeEvents(this.state.events, next);
      if (events !== this.state.events) this.set({ events });
      return true;
    } catch (e) {
      this.failed(e);
      return false;
    }
  }

  private async statusLoop() {
    while (!this.stopped) {
      const plan = this.plan();
      if (plan.stop) return;
      if (plan.waitSeconds > 0) {
        if (!(await this.readRun(plan.waitSeconds))) await this.pause(RETRY_MS);
      } else {
        await this.pause(plan.eventsEveryMs);
        if (!this.stopped) await this.readRun();
      }
    }
  }

  private async eventsLoop() {
    while (!this.stopped) {
      const plan = this.plan();
      if (plan.stop) return;
      await this.pause(plan.eventsEveryMs);
      if (this.stopped) return;
      if (!(await this.readEvents())) await this.pause(RETRY_MS);
    }
  }
}
