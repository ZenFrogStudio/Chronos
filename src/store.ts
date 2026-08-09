import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { pruneRuns } from './history';
import { log } from './log';
import { readState, writeState } from './state-file';
import { ChronosState, SCHEMA_VERSION, TaskRun, TaskSeries } from './types';

export function newId(): string {
  return randomUUID();
}

export class Store {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private constructor(
    private file: string,
    private state: ChronosState
  ) {}

  /**
   * Loads one folder's schedule. The reading, migrating and setting-aside all
   * happen in `state-file.ts`; this only reports what it did.
   */
  static async create(file: string): Promise<Store> {
    return new Store(file, load(file));
  }

  /**
   * Points the store at a different folder's state. This is the whole of what
   * switching folders means to the schedule — everything else in Chronos reads
   * through the store or through a path thunk.
   */
  async retarget(file: string): Promise<void> {
    this.file = file;
    this.state = load(file);
    this.emitter.fire();
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

  private async persist(): Promise<void> {
    this.state.runs = pruneRuns(this.state.runs);
    writeState(this.file, this.state);
    this.emitter.fire();
  }
}

function load(file: string): ChronosState {
  const result = readState(file);

  if (result.backedUpTo) {
    log.warn(`state at ${file} was unreadable — copied to ${result.backedUpTo}, starting fresh`);
  } else if (result.migratedFrom !== undefined) {
    log.info(`migrated ${file} from schema v${result.migratedFrom} to v${SCHEMA_VERSION}`);
  }

  log.info(
    `loaded ${result.state.series.length} series, ${result.state.runs.length} runs from ${file}`
  );
  return result.state;
}
