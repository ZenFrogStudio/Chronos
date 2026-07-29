import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { log } from './log';
import { migrate } from './migrate';
import {
  ChronusState,
  MAX_RECENT_RUNS,
  SCHEMA_VERSION,
  STORE_KEY,
  TaskRun,
  TaskSeries,
  isFinished
} from './types';

const BACKUP_KEY = 'chronus.state.backup';

export function newId(): string {
  return randomUUID();
}

function emptyState(): ChronusState {
  return { schemaVersion: SCHEMA_VERSION, series: [], runs: [] };
}

export class Store {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private constructor(
    private readonly memento: vscode.Memento,
    private state: ChronusState
  ) {}

  /**
   * Known older versions are upgraded through `migrate()`. Only a genuinely
   * unrecognisable shape is set aside under a backup key, and even then it is
   * preserved rather than dropped.
   */
  static async create(memento: vscode.Memento): Promise<Store> {
    const raw = memento.get<unknown>(STORE_KEY);

    if (raw === undefined) {
      return new Store(memento, emptyState());
    }

    const migrated = migrate(raw);
    if (migrated) {
      const from = (raw as Partial<ChronusState>).schemaVersion;
      if (from !== SCHEMA_VERSION) {
        log.info(`migrated stored state from schema v${from} to v${SCHEMA_VERSION}`);
        await memento.update(STORE_KEY, migrated);
      }
      log.info(`loaded ${migrated.series.length} series, ${migrated.runs.length} runs`);
      return new Store(memento, migrated);
    }

    log.warn('stored state unrecognised — preserved under backup key, starting fresh');
    await memento.update(BACKUP_KEY, raw);
    return new Store(memento, emptyState());
  }

  dispose(): void {
    this.emitter.dispose();
  }

  getSeries(): readonly TaskSeries[] {
    return this.state.series;
  }

  getSeriesById(id: string): TaskSeries | undefined {
    return this.state.series.find((s) => s.id === id);
  }

  getRuns(): readonly TaskRun[] {
    return this.state.runs;
  }

  getRunById(id: string): TaskRun | undefined {
    return this.state.runs.find((r) => r.id === id);
  }

  getRunsForSeries(seriesId: string): TaskRun[] {
    return this.state.runs.filter((r) => r.seriesId === seriesId);
  }

  /** Rolling spend. Surfaced in both views so a runaway series is noticed early. */
  costLast7Days(): number {
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    return this.state.runs
      .filter((r) => r.costUsd !== undefined && r.finishedAt !== undefined)
      .filter((r) => Date.parse(r.finishedAt as string) >= cutoff)
      .reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  }

  async addSeries(series: TaskSeries): Promise<void> {
    this.state.series.push(series);
    await this.persist();
  }

  async updateSeries(id: string, patch: Partial<TaskSeries>): Promise<void> {
    const series = this.getSeriesById(id);
    if (!series) {
      log.warn(`updateSeries: no series ${id}`);
      return;
    }
    Object.assign(series, patch);
    await this.persist();
  }

  /** Removes the series and its run history together. */
  async removeSeries(id: string): Promise<void> {
    this.state.series = this.state.series.filter((s) => s.id !== id);
    this.state.runs = this.state.runs.filter((r) => r.seriesId !== id);
    await this.persist();
  }

  async addRun(run: TaskRun): Promise<void> {
    this.state.runs.push(run);
    await this.persist();
  }

  async updateRun(id: string, patch: Partial<TaskRun>): Promise<void> {
    const run = this.getRunById(id);
    if (!run) {
      log.warn(`updateRun: no run ${id}`);
      return;
    }
    Object.assign(run, patch);
    await this.persist();
  }

  async removeRun(id: string): Promise<void> {
    this.state.runs = this.state.runs.filter((r) => r.id !== id);
    await this.persist();
  }

  /**
   * Caps finished-run history. Pending, running and missed runs are never
   * pruned — they still need a decision or are still in flight.
   */
  private prune(): void {
    const finished = this.state.runs.filter((r) => isFinished(r.status));
    if (finished.length <= MAX_RECENT_RUNS) {
      return;
    }
    const keep = new Set(
      finished
        .sort((a, b) => (b.finishedAt ?? b.scheduledAt).localeCompare(a.finishedAt ?? a.scheduledAt))
        .slice(0, MAX_RECENT_RUNS)
        .map((r) => r.id)
    );
    this.state.runs = this.state.runs.filter((r) => !isFinished(r.status) || keep.has(r.id));
  }

  private async persist(): Promise<void> {
    this.prune();
    await this.memento.update(STORE_KEY, this.state);
    this.emitter.fire();
  }
}
