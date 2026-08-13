import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import * as library from './library';
import { planSeriesOverrides, planSeriesUpdate, planTiming, ScheduleWhen } from './mcp-tools';
import { pathsFor, ensureRoot, ChronosPaths } from './roots';
import { createSeries } from './series';
import { readState, updateState } from './state-file';
import { ChronosState, TaskRun, TaskSeries } from './types';

/**
 * Chronos as an MCP server: the door any coding agent drives it through.
 *
 * Spawned as a child process by the agent (Claude Code, Hermes, Cursor), scoped
 * to one project folder given as `--folder`, and speaking JSON-RPC over stdio.
 * It never talks to VS Code and never opens a port — it reads and writes the
 * same `.chronos` tree the extension does, and the open window notices.
 *
 * It holds no state. Every call re-reads the folder and writes back through
 * `updateState`, whose read-modify-write is exactly what lets two editor windows
 * share one schedule; a server process is one more writer of that kind.
 *
 * //Steps to completion:
 *
 *   //Resolve the project folder from --folder, defaulting to cwd;
 *   //Register the read tools, which never create anything on disk;
 *   //Register the write tools, each one going through mcp-tools.ts first;
 *   //Serve over stdio, logging to stderr only.
 *
 * Two containment rules live here, at the filesystem edge, and neither is in
 * `mcp-tools.ts` because both are about paths rather than about rules:
 *
 * - **A plan is addressed by name, never by path.** Every name is resolved
 *   through `library.planPath`, which throws on anything escaping the library —
 *   so `schedule_plan` cannot be aimed at an arbitrary file on this disk.
 * - **Writes stay under `--folder`'s `.chronos`,** and the tree is created on
 *   the first write rather than at start-up, so an agent merely listing an
 *   unconfigured project does not litter it.
 *
 * Nothing here may write to stdout: that is the transport, and one stray
 * `console.log` corrupts the protocol mid-session. `log.ts` imports `vscode` and
 * cannot be used, so `note()` below writes to stderr directly.
 */

///////////////////////////*Process setup*////////////////////////////

const VERSION = '0.8.0';

/**
 * Retries for a series an agent schedules. The manifest default for
 * `chronos.maxRetries`, restated rather than read: settings live in VS Code and
 * this process has no way to reach them. A caller who wants something else
 * passes `maxRetries`, and the manager can change it afterwards either way.
 */
const DEFAULT_MAX_RETRIES = 3;

/** stderr, because stdout is the wire. The agent surfaces this in its own log. */
function note(text: string): void {
  process.stderr.write(`[chronos-mcp] ${text}\n`);
}

/**
 * The project folder this server speaks for, fixed for the life of the process.
 * One folder per server, matching the extension: a schedule belongs to a
 * project, and an agent is already working in one.
 */
function folderArg(argv: readonly string[]): string {
  const flag = argv.indexOf('--folder');
  const value = flag >= 0 ? argv[flag + 1] : undefined;
  return path.resolve(value && !value.startsWith('--') ? value : process.cwd());
}

const FOLDER = folderArg(process.argv.slice(2));
const paths = (): ChronosPaths => pathsFor(FOLDER);

/** Called before every write, never before a read. See the header. */
function ensureWritable(): ChronosPaths {
  const resolved = paths();
  ensureRoot(resolved);
  return resolved;
}

///////////////////////////*Replies*////////////////////////////

/**
 * `permissionMode` is declared on both write tools purely so it can be refused.
 *
 * Leaving it off the schema is not the same thing: zod strips a key it does not
 * declare, so the argument would never reach `mcp-tools.ts` and the agent would
 * get a plain success for a call that quietly did not do what it asked. Wrong in
 * both directions — the task is safe either way, but the agent goes on believing
 * it raised the permissions, and the user is never told it tried. Declared, it
 * reaches the gate, gets refused by name, and shows up in the tool list as
 * something a person sets.
 */
const permissionModeArg = z
  .string()
  .optional()
  .describe('Not settable over MCP. Sending it refuses the call; a person sets it in the manager.');

/** Every tool answers with text — JSON for lists, Markdown for file bodies. */
const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const replyJson = (value: unknown) => reply(JSON.stringify(value, null, 2));

/**
 * A refusal the agent can read and act on, rather than a thrown error.
 * `isError` is what tells the client this is a failed call and not an answer.
 */
const refuse = (reason: string) => ({
  content: [{ type: 'text' as const, text: reason }],
  isError: true
});

/**
 * Resolves a plan name, or explains why it will not. Wrapping `planPath`'s throw
 * turns a traversal attempt into an ordinary refused tool call — the agent gets
 * a sentence instead of a stack trace, and the outcome is identical.
 */
function resolvePlan(dir: string, name: string): { filePath: string } | { reason: string } {
  let filePath: string;
  try {
    filePath = library.planPath(dir, name);
  } catch {
    return { reason: `"${name}" is not a plan name. Use the name as list_plans reports it.` };
  }
  if (!fs.existsSync(filePath)) {
    return { reason: `There is no plan called "${name}". Call list_plans to see what there is.` };
  }
  return { filePath };
}

const state = (): ChronosState => readState(paths().state).state;

/** The view of a series an agent gets. `filePath` is included for orientation
 *  only — nothing may be scheduled by path, and no tool accepts one back. */
function describeSeries(series: TaskSeries) {
  return {
    id: series.id,
    plan: series.fileName,
    nextRunAt: series.nextRunAt,
    recurrence: series.recurrence,
    enabled: series.enabled,
    spent: series.spent ?? false,
    engine: series.agent ?? 'claude',
    model: series.model ?? '(account default)',
    permissionMode: series.permissionMode,
    cwd: series.cwd,
    maxRetries: series.maxRetries
  };
}

function describeRun(run: TaskRun) {
  return {
    id: run.id,
    seriesId: run.seriesId,
    status: run.status,
    attempt: run.attempt,
    scheduledAt: run.scheduledAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    costUsd: run.costUsd,
    denials: run.denials,
    result: run.result,
    lastError: run.lastError,
    hasTranscript: Boolean(run.resultPath)
  };
}

///////////////////////////*The tool surface*////////////////////////////

const server = new McpServer(
  { name: 'chronos', version: VERSION },
  { capabilities: { tools: {} } }
);

// ---------- read ----------

server.registerTool(
  'list_plans',
  {
    title: 'List plans',
    description:
      'The Chronos plan library for this project: every Markdown plan that can be scheduled. ' +
      'Newest first. A plan is addressed by its `name` everywhere else in this server.',
    inputSchema: z.object({})
  },
  async () =>
    replyJson(
      library.listPlans(paths().plans).map((plan) => ({
        name: plan.name,
        title: plan.title,
        modified: new Date(plan.modifiedMs).toISOString(),
        sizeBytes: plan.sizeBytes
      }))
    )
);

server.registerTool(
  'read_plan',
  {
    title: 'Read a plan',
    description: 'The Markdown body of one plan, by the name list_plans reports.',
    inputSchema: z.object({ name: z.string().describe('Plan file name, e.g. "nightly-audit.md"') })
  },
  async ({ name }) => {
    const dir = paths().plans;
    const found = resolvePlan(dir, name);
    if ('reason' in found) {
      return refuse(found.reason);
    }
    return reply(library.readPlan(dir, name));
  }
);

server.registerTool(
  'list_tasks',
  {
    title: 'List captured tasks',
    description:
      'The capture inbox: one-line jobs noted down but not yet written up as a plan. ' +
      'These are what the Chronos sidebar shows.',
    inputSchema: z.object({})
  },
  async () => {
    const dir = paths().tasks;
    return replyJson(
      library.listPlans(dir).map((task) => ({
        name: task.name,
        text: library.taskLabel(safeRead(task.filePath)),
        captured: new Date(task.modifiedMs).toISOString()
      }))
    );
  }
);

server.registerTool(
  'list_schedule',
  {
    title: 'List the schedule',
    description:
      'Every scheduled series in this project: which plan it runs, when it runs next, whether ' +
      'it repeats, and what it runs as. Use the `id` for update_schedule and unschedule.',
    inputSchema: z.object({})
  },
  async () => replyJson(state().series.map(describeSeries))
);

server.registerTool(
  'list_runs',
  {
    title: 'List runs',
    description:
      'Recent run history — what actually happened when a scheduled task fired, including ' +
      'cost, permission denials and the agent’s closing message.',
    inputSchema: z.object({
      seriesId: z.string().optional().describe('Only runs of this series. Omit for all.'),
      limit: z.number().int().min(1).max(100).optional().describe('Newest first. Default 20.')
    })
  },
  async ({ seriesId, limit }) => {
    const runs = state()
      .runs.filter((run) => !seriesId || run.seriesId === seriesId)
      .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt))
      .slice(0, limit ?? 20);
    return replyJson(runs.map(describeRun));
  }
);

server.registerTool(
  'read_transcript',
  {
    title: 'Read a run transcript',
    description:
      'The full Markdown transcript of a finished run: what the agent was asked, what it did, ' +
      'and how it ended. Only finished runs have one.',
    inputSchema: z.object({ runId: z.string().describe('A run id from list_runs') })
  },
  async ({ runId }) => {
    const run = state().runs.find((r) => r.id === runId);
    if (!run) {
      return refuse('No run has that id. Call list_runs for the current ones.');
    }
    if (!run.resultPath) {
      return refuse(`That run (${run.status}) has no transcript.`);
    }
    try {
      return reply(fs.readFileSync(run.resultPath, 'utf8'));
    } catch {
      return refuse(`Its transcript is no longer on disk at ${run.resultPath}.`);
    }
  }
);

// ---------- write ----------

server.registerTool(
  'add_task',
  {
    title: 'Capture a task',
    description:
      'Notes a one-line job into the Chronos inbox, where it appears in the sidebar of any open ' +
      'VS Code window on this project. Capture only — nothing is scheduled and nothing runs.',
    inputSchema: z.object({ text: z.string().min(1).max(2000).describe('What needs doing') })
  },
  async ({ text }) => {
    const clean = text.trim();
    if (!clean) {
      return refuse('A task needs some text.');
    }
    const task = library.createPlan(ensureWritable().tasks, clean, `${clean}\n`);
    note(`captured task ${task.name}`);
    return reply(`Captured "${task.title}" in the Chronos inbox as ${task.name}.`);
  }
);

server.registerTool(
  'add_plan',
  {
    title: 'Write a plan',
    description:
      'Writes a Markdown plan into the library. This is what a scheduled run hands the coding ' +
      'agent as its prompt, so write it as instructions. Does not schedule it — call ' +
      'schedule_plan with the name this returns.',
    inputSchema: z.object({
      title: z.string().min(1).max(200).describe('Plain-language title; the file name is derived from it'),
      body: z.string().min(1).max(500_000).describe('The plan itself, as Markdown')
    })
  },
  async ({ title, body }) => {
    const plan = library.createPlan(ensureWritable().plans, title, body);
    note(`wrote plan ${plan.name}`);
    return reply(`Wrote ${plan.name} to the plan library. Schedule it with schedule_plan.`);
  }
);

server.registerTool(
  'schedule_plan',
  {
    title: 'Schedule a plan',
    description:
      'Puts a plan on the schedule. The open VS Code window fires it at the time given — this ' +
      'does not run anything now. New tasks always run in `auto` permission mode; that cannot ' +
      'be set from here.',
    inputSchema: z.object({
      name: z.string().describe('Plan file name, from list_plans or add_plan'),
      at: z
        .string()
        .optional()
        .describe('ISO 8601 date and time of the first run. Required unless `repeat` is set.'),
      repeat: z
        .enum(['once', 'daily', 'weekly', 'monthly'])
        .optional()
        .describe('Default once'),
      timeLocal: z
        .string()
        .optional()
        .describe('"HH:MM" local time for a repeating rule. Taken from `at` if omitted.'),
      daysOfWeek: z
        .array(z.number().int().min(0).max(6))
        .optional()
        .describe('Weekly rules only. 0 = Sunday .. 6 = Saturday.'),
      dayOfMonth: z
        .number()
        .int()
        .min(1)
        .max(31)
        .optional()
        .describe('Monthly rules only. Defaults to the day `at` falls on.'),
      agent: z.enum(['claude', 'opencode']).optional().describe('Engine. Default claude.'),
      model: z.string().optional().describe('Model id. Omit for the account default.'),
      cwd: z.string().optional().describe('Working directory for the run. Defaults to this project.'),
      maxRetries: z.number().int().min(0).max(10).optional(),
      permissionMode: permissionModeArg
    })
  },
  async (args) => {
    // As in `update_schedule`: nothing is created until the call has survived
    // every check, so a refused call leaves an unconfigured folder untouched.
    const resolved = paths();
    const found = resolvePlan(resolved.plans, args.name);
    if ('reason' in found) {
      return refuse(found.reason);
    }

    const timing = planTiming(args as ScheduleWhen);
    if (!timing.ok) {
      return refuse(timing.reason);
    }

    // Only the fields an agent may set are forwarded, so a stray argument is
    // never silently written; `planSeriesOverrides` refuses anything else.
    const overrides = planSeriesOverrides({
      ...pick(args, ['agent', 'model', 'cwd', 'maxRetries', 'permissionMode']),
      ...timing.value
    });
    if (!overrides.ok) {
      return refuse(overrides.reason);
    }

    const series = createSeries(
      found.filePath,
      { cwd: resolved.folder, maxRetries: DEFAULT_MAX_RETRIES },
      overrides.value
    );
    updateState(ensureWritable().state, (current) => {
      current.series.push(series);
    });

    note(`scheduled ${series.fileName} for ${series.nextRunAt}`);
    return replyJson({
      scheduled: series.fileName,
      ...describeSeries(series),
      note: 'It runs in `auto` permission mode. Raise that in the Chronos manager if it needs more.'
    });
  }
);

server.registerTool(
  'update_schedule',
  {
    title: 'Change a schedule',
    description:
      'Reschedules, re-repeats, pauses or resumes an existing series. Permission mode cannot be ' +
      'changed from here.',
    inputSchema: z.object({
      id: z.string().describe('Series id, from list_schedule'),
      at: z.string().optional().describe('ISO 8601 date and time to move the next run to'),
      repeat: z.enum(['once', 'daily', 'weekly', 'monthly']).optional(),
      timeLocal: z.string().optional().describe('"HH:MM" local time for a repeating rule'),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional(),
      enabled: z.boolean().optional().describe('False pauses the series, including queued retries'),
      agent: z.enum(['claude', 'opencode']).optional(),
      model: z.string().optional(),
      cwd: z.string().optional(),
      maxRetries: z.number().int().min(0).max(10).optional(),
      permissionMode: permissionModeArg
    })
  },
  async (args) => {
    // Read and validate before `ensureWritable`, so a call that is going to be
    // refused does not leave a `.chronos` tree behind in an unconfigured folder.
    const series = state().series.find((s) => s.id === args.id);

    const patch: Record<string, unknown> = pick(args, [
      'enabled',
      'agent',
      'model',
      'cwd',
      'maxRetries',
      'permissionMode'
    ]);

    // Timing is only recomputed when the caller said something about it —
    // otherwise pausing a task would silently move when it next runs.
    if (args.at !== undefined || args.repeat !== undefined || args.timeLocal !== undefined) {
      const timing = planTiming(args as ScheduleWhen);
      if (!timing.ok) {
        return refuse(timing.reason);
      }
      Object.assign(patch, timing.value);
      // A one-shot that already fired stays spent unless it is given a new time,
      // which is the one thing that makes it due again.
      patch.spent = false;
    }

    const verdict = planSeriesUpdate(patch, series);
    if (!verdict.ok) {
      return refuse(verdict.reason);
    }

    let updated: TaskSeries | undefined;
    updateState(ensureWritable().state, (current) => {
      const target = current.series.find((s) => s.id === args.id);
      if (target) {
        Object.assign(target, verdict.value);
        updated = target;
      }
    });

    if (!updated) {
      return refuse('That task was removed while this call was in flight.');
    }
    note(`updated series ${updated.id}`);
    return replyJson(describeSeries(updated));
  }
);

server.registerTool(
  'unschedule',
  {
    title: 'Unschedule a task',
    description:
      'Removes a series from the schedule, together with its run history. The plan file itself ' +
      'is untouched and can be scheduled again. To stop a task without losing its history, call ' +
      'update_schedule with enabled: false.',
    inputSchema: z.object({ id: z.string().describe('Series id, from list_schedule') })
  },
  async ({ id }) => {
    const series = state().series.find((s) => s.id === id);
    if (!series) {
      return refuse('No scheduled task has that id. Call list_schedule for the current ids.');
    }

    updateState(ensureWritable().state, (current) => {
      current.series = current.series.filter((s) => s.id !== id);
      current.runs = current.runs.filter((r) => r.seriesId !== id);
    });

    note(`unscheduled ${series.fileName}`);
    return reply(`Unscheduled ${series.fileName}. Its plan is still in the library.`);
  }
);

///////////////////////////*Helpers*////////////////////////////

/** Copies across only the keys that were actually given, so an omitted argument
 *  stays omitted rather than becoming an explicit `undefined` in a patch. */
function pick<T extends object>(source: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key as string] = source[key];
    }
  }
  return out;
}

/** A task file that vanished mid-listing is worth an empty row, not a failure. */
function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

///////////////////////////*Serve*////////////////////////////

note(`serving ${FOLDER}`);

serveStdio(() => server, {
  onerror: (err) => note(`transport error: ${err.message}`)
});
