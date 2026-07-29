import * as vscode from 'vscode';
import { Action, decide, newRun } from './decide';
import { log } from './log';
import { RunFinished, Runner } from './runner';
import { newId, Store } from './store';
import { nowUtc } from './time';
import { MissedReason, TICK_MS, TaskRun } from './types';

export class Scheduler implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private lastTickMs = Date.now();
  private ticking = false;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly store: Store,
    private readonly runner: Runner
  ) {
    this.subscription = runner.onDidFinish((e) => {
      void this.onFinished(e);
    });
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.subscription.dispose();
  }

  async start(): Promise<void> {
    await this.reconcile();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    await this.tick();
  }

  /**
   * Fires a series immediately, independent of its schedule. Flagged `manual`
   * so it still runs on a paused or spent series — which is the whole point of
   * the button.
   */
  async runNow(seriesId: string): Promise<void> {
    const series = this.store.getSeriesById(seriesId);
    if (!series) {
      return;
    }
    await this.store.addRun({ ...newRun(series, nowUtc(), 1, newId()), manual: true });
    await this.tick();
  }

  /** Stops a run that is currently executing. */
  cancelRun(runId: string): void {
    this.runner.cancel(runId);
  }

  /**
   * A run left `running` has no process behind it — VS Code closed mid-flight.
   * Without this the concurrency slot is held forever.
   */
  private async reconcile(): Promise<void> {
    const orphans = this.store.getRuns().filter((r) => r.status === 'running');
    for (const run of orphans) {
      await this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: nowUtc(),
        lastError: 'Interrupted — VS Code closed during execution.'
      });
      log.warn(`reconciled orphaned run ${run.id}`);
      await this.afterTerminalOutcome(run, true);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.evaluate();
    } catch (err) {
      log.error('scheduler tick failed', err);
    } finally {
      this.ticking = false;
    }
  }

  /** Gathers the clock and config, delegates the judgement, applies the result. */
  private async evaluate(): Promise<void> {
    const now = Date.now();

    // A gap far larger than the interval means the process was suspended.
    // Only used to word the notification.
    const drift = now - this.lastTickMs;
    this.lastTickMs = now;
    const reason: MissedReason = drift > TICK_MS * 3 ? 'sleep' : 'not-running';

    this.runner.checkWatchdogs();

    const actions = decide({
      series: this.store.getSeries(),
      runs: this.store.getRuns(),
      now,
      graceMs: config().get<number>('graceWindowMinutes', 15) * 60_000,
      reason,
      isSeriesRunning: (id) => this.runner.isSeriesRunning(id),
      freeSlots: this.runner.freeSlots(),
      newId
    });

    for (const action of actions) {
      await this.apply(action);
    }
  }

  private async apply(action: Action): Promise<void> {
    switch (action.kind) {
      case 'addRun':
        return this.store.addRun(action.run);
      case 'updateSeries':
        return this.store.updateSeries(action.id, action.patch);
      case 'updateRun':
        return this.store.updateRun(action.id, action.patch);
      case 'removeRun':
        return this.store.removeRun(action.id);
      case 'start':
        return this.runner.begin(action.series, action.run);
      case 'announceMissed':
        return this.announceMissed(action.count, action.reason);
    }
  }

  private async onFinished(event: RunFinished): Promise<void> {
    const run = this.store.getRunById(event.runId);
    if (!run) {
      return;
    }

    if (event.outcome.ok) {
      if (event.outcome.denials > 0) {
        vscode.window.showWarningMessage(
          `Chronus: ${runLabel(this.store, run)} finished with ${event.outcome.denials} ` +
            'permission denial(s) — part of the plan may not have run.'
        );
      }
      return;
    }

    await this.afterTerminalOutcome(run, event.outcome.retryable);
  }

  /** Retry, or give up and report. */
  private async afterTerminalOutcome(run: TaskRun, retryable: boolean): Promise<void> {
    const series = this.store.getSeriesById(run.seriesId);
    if (!series) {
      return;
    }

    const retriesUsed = run.attempt - 1;
    if (retryable && retriesUsed < series.maxRetries) {
      const delay = config().get<number>('retryDelayMinutes', 60);
      await this.store.addRun(
        newRun(
          series,
          new Date(Date.now() + delay * 60_000).toISOString(),
          run.attempt + 1,
          newId()
        )
      );
      log.info(`run ${run.id} failed — retry ${run.attempt} queued in ${delay}m`);
      return;
    }

    vscode.window
      .showErrorMessage(
        `Chronus: ${series.fileName} failed${
          retriesUsed > 0 ? ` after ${retriesUsed} retries` : ''
        }.`,
        'Show Logs'
      )
      .then((choice) => {
        if (choice === 'Show Logs') {
          log.show();
        }
      });
  }

  private announceMissed(count: number, reason: MissedReason): void {
    const plural = count > 1;
    vscode.window.showWarningMessage(
      `Chronus: ${count} task${plural ? 's' : ''} missed ${plural ? 'their' : 'its'} ` +
        `scheduled time while ${
          reason === 'sleep' ? 'your machine was asleep' : 'VS Code was closed'
        }.`
    );
    log.warn(`${count} missed occurrence(s), reason=${reason}`);
  }
}

function runLabel(store: Store, run: TaskRun): string {
  return store.getSeriesById(run.seriesId)?.fileName ?? 'Task';
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('chronus');
}
