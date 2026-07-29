import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Outcome } from '../src/outcome';
import {
  localStamp,
  parseLine,
  toAnsi,
  toMarkdown,
  transcriptFooter,
  transcriptHeader
} from '../src/transcript';

function assistantEvent(content: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { content } });
}

function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return { ok: true, denials: 0, retryable: false, ...overrides };
}

const CONTEXT = {
  fileName: 'nightly-audit.md',
  cwd: 'D:\\repo',
  permissionMode: 'bypassPermissions',
  startedAt: new Date(2026, 6, 26, 21, 30),
  attempt: 1
};

describe('parseLine — recognising events', () => {
  it('should_ignore_a_line_that_is_not_json', () => {
    assert.deepEqual(parseLine('warming up...'), { events: [], isResult: false });
  });

  it('should_ignore_a_truncated_json_line', () => {
    // Progress lines can be cut mid-stream; a parse failure must not throw.
    assert.deepEqual(parseLine('{"type":"assist'), { events: [], isResult: false });
  });

  it('should_read_the_session_and_model_from_the_init_event', () => {
    const { events } = parseLine('{"type":"system","subtype":"init","session_id":"s1","model":"opus"}');

    assert.deepEqual(events, [{ kind: 'session', sessionId: 's1', model: 'opus' }]);
  });

  it('should_read_assistant_text_and_tool_calls_in_order', () => {
    const line = assistantEvent([
      { type: 'text', text: '  Checking the build.  ' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }
    ]);

    const { events } = parseLine(line);

    assert.deepEqual(events, [
      { kind: 'text', text: 'Checking the build.' },
      { kind: 'tool', name: 'Bash', detail: 'npm test' }
    ]);
  });

  it('should_drop_empty_assistant_text_rather_than_emit_a_blank_line', () => {
    const { events } = parseLine(assistantEvent([{ type: 'text', text: '   ' }]));

    assert.deepEqual(events, []);
  });

  it('should_flag_the_result_line_so_the_runner_can_retain_only_that_one', () => {
    // The whole point of the flag: it is what lets the runner throw away every
    // other line instead of accumulating the stream in memory.
    const { isResult } = parseLine('{"type":"result","num_turns":4,"total_cost_usd":0.23}');

    assert.equal(isResult, true);
  });

  it('should_count_permission_denials_on_the_result_event', () => {
    const { events } = parseLine(
      '{"type":"result","num_turns":2,"permission_denials":[{"tool":"Bash"},{"tool":"Write"}]}'
    );

    assert.deepEqual(events, [{ kind: 'result', turns: 2, costUsd: undefined, denials: 2 }]);
  });
});

describe('parseLine — tool detail', () => {
  it('should_prefer_the_command_when_recording_a_shell_call', () => {
    const { events } = parseLine(
      assistantEvent([{ type: 'tool_use', name: 'Bash', input: { command: 'git status', timeout: 5 } }])
    );

    assert.equal(events[0].kind === 'tool' && events[0].detail, 'git status');
  });

  it('should_record_the_file_path_for_an_edit', () => {
    const { events } = parseLine(
      assistantEvent([{ type: 'tool_use', name: 'Edit', input: { file_path: 'D:\\repo\\src\\a.ts' } }])
    );

    assert.equal(events[0].kind === 'tool' && events[0].detail, 'D:\\repo\\src\\a.ts');
  });

  it('should_cap_a_pathological_tool_argument', () => {
    const { events } = parseLine(
      assistantEvent([{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(5000) } }])
    );

    const detail = events[0].kind === 'tool' ? (events[0].detail ?? '') : '';
    assert.ok(detail.length < 250, `detail was ${detail.length} chars`);
  });

  it('should_leave_detail_absent_when_no_recognised_field_is_present', () => {
    const { events } = parseLine(
      assistantEvent([{ type: 'tool_use', name: 'Mystery', input: { limit: 3 } }])
    );

    assert.deepEqual(events, [{ kind: 'tool', name: 'Mystery', detail: undefined }]);
  });
});

describe('toAnsi and toMarkdown — one parse, two renderings', () => {
  it('should_render_assistant_text_identically_in_both', () => {
    const event = { kind: 'text', text: 'Found three failures.' } as const;

    assert.equal(toAnsi(event), 'Found three failures.');
    assert.equal(toMarkdown(event), 'Found three failures.');
  });

  it('should_fence_a_tool_argument_so_backticks_cannot_break_the_document', () => {
    const event = { kind: 'tool', name: 'Bash', detail: 'echo `whoami`' } as const;

    const markdown = toMarkdown(event) ?? '';

    assert.ok(markdown.includes('```\necho `whoami`\n```'), markdown);
  });

  it('should_omit_the_session_event_from_the_transcript_since_the_header_has_it', () => {
    const event = { kind: 'session', sessionId: 's1', model: 'opus' } as const;

    assert.ok(toAnsi(event));
    assert.equal(toMarkdown(event), undefined);
  });

  it('should_omit_the_result_event_from_the_transcript_since_the_footer_has_it', () => {
    const event = { kind: 'result', turns: 3, costUsd: 0.2, denials: 0 } as const;

    assert.ok(toAnsi(event));
    assert.equal(toMarkdown(event), undefined);
  });
});

describe('transcriptHeader', () => {
  it('should_record_the_conditions_the_run_executed_under', () => {
    const header = transcriptHeader(CONTEXT);

    assert.ok(header.startsWith('# nightly-audit.md'));
    assert.ok(header.includes('2026-07-26 21:30'));
    assert.ok(header.includes('D:\\repo'));
    assert.ok(header.includes('bypassPermissions'));
  });

  it('should_say_default_when_no_model_is_pinned', () => {
    assert.ok(transcriptHeader(CONTEXT).includes('| Model | default |'));
  });

  it('should_note_the_attempt_only_when_this_is_a_retry', () => {
    assert.ok(!transcriptHeader(CONTEXT).includes('Attempt'));
    assert.ok(transcriptHeader({ ...CONTEXT, attempt: 3 }).includes('retry 2'));
  });

  it('should_escape_a_pipe_so_it_cannot_split_a_table_cell', () => {
    const header = transcriptHeader({ ...CONTEXT, cwd: 'D:\\a|b' });

    assert.ok(header.includes('D:\\a\\|b'));
  });
});

describe('transcriptFooter', () => {
  it('should_state_success_with_turns_cost_and_duration', () => {
    const footer = transcriptFooter(outcome({ numTurns: 4, costUsd: 0.2312 }), 192_000);

    assert.ok(footer.includes('**Completed**'));
    assert.ok(footer.includes('4 turns'));
    assert.ok(footer.includes('$0.2312'));
    assert.ok(footer.includes('3m 12s'));
  });

  it('should_state_the_error_when_the_run_failed', () => {
    const footer = transcriptFooter(
      outcome({ ok: false, error: 'Killed — exceeded the maximum runtime.' }),
      60_000
    );

    assert.ok(footer.includes('**Failed**'));
    assert.ok(footer.includes('exceeded the maximum runtime'));
  });

  it('should_call_out_permission_denials_prominently_on_an_otherwise_successful_run', () => {
    // The failure mode this exists for: exit 0, work silently not done.
    const footer = transcriptFooter(outcome({ numTurns: 2, denials: 3 }), 10_000);

    assert.ok(footer.includes('**Completed**'));
    assert.ok(footer.includes('3 tool call(s) were blocked'));
    assert.ok(footer.includes('did not run'));
  });

  it('should_stay_silent_about_denials_when_there_were_none', () => {
    assert.ok(!transcriptFooter(outcome({ numTurns: 1 }), 1000).includes('blocked'));
  });
});

describe('localStamp', () => {
  it('should_format_local_wall_clock_time_zero_padded', () => {
    assert.equal(localStamp(new Date(2026, 0, 5, 9, 7)), '2026-01-05 09:07');
  });
});
