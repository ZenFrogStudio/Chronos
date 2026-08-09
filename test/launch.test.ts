import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildArgs, generateCommand, preflightError, shellKind, Shell } from '../src/launch';
import { AgentId, PermissionMode } from '../src/types';

const PLAN = 'D:\\plans\\refactor.md';
const CWD = 'D:\\repo';

const launchable = (permissionMode: PermissionMode = 'acceptEdits', model?: string) => ({
  filePath: PLAN,
  cwd: CWD,
  permissionMode,
  model
});

const onEngine = (agent: AgentId, permissionMode: PermissionMode = 'acceptEdits', model?: string) => ({
  ...launchable(permissionMode, model),
  agent
});

/** Everything present and readable, unless a test says otherwise. */
const allExist = () => true;
const readsPlan = () => '# Do the thing\n';

describe('buildArgs', () => {
  it('should_always_run_headless_with_a_streamed_result', () => {
    const args = buildArgs(launchable());

    assert.ok(args.includes('-p'), 'without -p the CLI blocks on interactive approval');
    assert.deepEqual(args.slice(1, 4), ['--output-format', 'stream-json', '--verbose']);
  });

  it('should_pass_the_selected_permission_mode_through', () => {
    const args = buildArgs(launchable('plan'));

    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  });

  it('should_pass_the_bypass_flag_only_for_bypass_permissions', () => {
    // The flag enables the capability rather than applying it, so the two must
    // travel together. Shipped unverified in 0.4.0.
    const bypass = buildArgs(launchable('bypassPermissions'));
    const normal = buildArgs(launchable('acceptEdits'));

    assert.ok(bypass.includes('--allow-dangerously-skip-permissions'));
    assert.ok(!normal.includes('--allow-dangerously-skip-permissions'));
  });

  it('should_omit_the_model_flag_when_no_model_is_pinned', () => {
    assert.ok(!buildArgs(launchable()).includes('--model'));
  });

  it('should_pin_the_model_when_one_is_chosen', () => {
    const args = buildArgs(launchable('acceptEdits', 'opus'));

    assert.equal(args[args.indexOf('--model') + 1], 'opus');
  });

  it('should_never_place_the_prompt_on_the_command_line', () => {
    // The plan travels on stdin: no argv length limit, no shell escaping.
    const args = buildArgs(launchable('acceptEdits', 'opus'));

    assert.ok(!args.some((arg) => arg.includes(PLAN)));
  });

  it('should_treat_a_series_with_no_engine_as_a_claude_series', () => {
    // What every series stored before engines existed means, which is why
    // adding the field needed no migration.
    assert.deepEqual(buildArgs(launchable()), buildArgs(onEngine('claude')));
  });
});

describe('buildArgs — opencode', () => {
  it('should_ask_for_the_ndjson_stream_the_transcript_is_parsed_from', () => {
    const args = buildArgs(onEngine('opencode'));

    assert.deepEqual(args.slice(0, 3), ['run', '--format', 'json']);
  });

  it('should_name_the_working_directory_rather_than_relying_on_the_process_cwd', () => {
    // opencode runs its tools through a server of its own that resolves the
    // project root independently, so it does not inherit the spawned process's
    // working directory. Without --dir a task pointed at one repo edits
    // whichever repo opencode picked — with permissions wide open.
    const args = buildArgs(onEngine('opencode'));

    assert.equal(args[args.indexOf('--dir') + 1], CWD);
  });

  it('should_never_emit_a_claude_flag', () => {
    // The two CLIs share a stream shape, not a command line.
    const args = buildArgs(onEngine('opencode', 'bypassPermissions', 'opencode/big-pickle'));

    for (const flag of ['-p', '--output-format', '--verbose', '--permission-mode', '--model']) {
      assert.ok(!args.includes(flag), `${flag} means nothing to opencode`);
    }
  });

  it('should_auto_approve_for_every_mode_that_means_do_not_stop_and_ask', () => {
    // opencode has one approval control where Claude has six. Without --auto an
    // unattended run blocks on a prompt nobody is awake to answer.
    for (const mode of ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'] as PermissionMode[]) {
      assert.ok(buildArgs(onEngine('opencode', mode)).includes('--auto'), mode);
    }
  });

  it('should_withhold_auto_approval_in_plan_and_manual_modes', () => {
    for (const mode of ['plan', 'manual'] as PermissionMode[]) {
      assert.ok(!buildArgs(onEngine('opencode', mode)).includes('--auto'), mode);
    }
  });

  it('should_pin_the_model_with_opencodes_own_flag', () => {
    const args = buildArgs(onEngine('opencode', 'auto', 'opencode/north-mini-code-free'));

    assert.equal(args[args.indexOf('-m') + 1], 'opencode/north-mini-code-free');
  });

  it('should_omit_the_model_flag_when_no_model_is_pinned', () => {
    assert.ok(!buildArgs(onEngine('opencode')).includes('-m'));
  });

  it('should_never_place_the_prompt_on_the_command_line', () => {
    // `opencode run --format json` reads its prompt from stdin, same as claude.
    const args = buildArgs(onEngine('opencode', 'auto', 'opencode/big-pickle'));

    assert.ok(!args.some((arg) => arg.includes(PLAN)));
  });

  it('should_pass_a_working_directory_containing_spaces_as_one_argument', () => {
    // `runner.ts` quotes every argv entry on Windows for exactly this — under
    // `shell: true` Node quotes nothing, so an unquoted path would arrive as
    // three arguments.
    const spaced = 'C:\\My Projects\\site';
    const args = buildArgs({ ...onEngine('opencode'), cwd: spaced });

    assert.equal(args[args.indexOf('--dir') + 1], spaced);
  });
});

const TASK = 'D:\\plans\\tasks\\refactor-the-auth-module.md';
const LIBRARY = 'D:\\plans';
const STAGING = 'D:\\plans\\.pending\\ab12cd';

const generatable = (overrides: Partial<Parameters<typeof generateCommand>[0]> = {}) => ({
  exe: 'claude',
  sourcePath: PLAN,
  allowDir: LIBRARY,
  shell: 'posix' as Shell,
  ...overrides
});

describe('generateCommand', () => {
  it('should_name_the_source_file_rather_than_carrying_its_text', () => {
    const command = generateCommand(generatable());

    // The source is named, not pasted: a task can grow past one line, a plan body
    // can be tens of kilobytes, and neither survives a shell prompt.
    assert.ok(command.includes(PLAN), 'Claude is told which file to read');
    assert.ok(!command.includes('\n'), 'a multi-line body would break the command');
  });

  it('should_write_the_plan_somewhere_other_than_the_task_file', () => {
    // The task view's whole point: a one-line task must never be the thing that
    // gets overwritten by the plan generated from it.
    const command = generateCommand(generatable({ sourcePath: TASK, destDir: STAGING }));

    assert.ok(command.includes(`save the approved plan as a new .md file in ${STAGING}`));
    assert.ok(!command.includes(`overwrite that same file`));
  });

  it('should_ask_claude_to_name_the_file_after_the_change', () => {
    // Chronos cannot name the plan before it exists — guessing from the task
    // text is what filled the library with truncated request lines.
    const command = generateCommand(generatable({ sourcePath: TASK, destDir: STAGING }));

    assert.ok(command.includes('Name that file with a short summary of the change'));
  });

  it('should_not_ask_for_a_name_when_overwriting_in_place', () => {
    // The manager's own button re-plans a library plan in place, and that plan
    // already has a name the user chose.
    const command = generateCommand(generatable());

    assert.ok(command.includes('overwrite that same file with the approved plan'));
    assert.ok(!command.includes('Name that file'));
  });

  it('should_keep_the_instruction_free_of_shell_metacharacters', () => {
    // The instruction is one quoted argument typed into a live shell prompt:
    // interactive bash expands `!`, PowerShell expands `$`, and both run a
    // backtick or quote. Nothing here may be any of those.
    const command = generateCommand(generatable({ sourcePath: TASK, destDir: STAGING }));

    assert.ok(!command.includes('`'), 'a backtick would run a command');
    assert.ok(!command.includes('$'), 'PowerShell would expand it');
    assert.ok(!command.includes('!'), 'interactive bash would expand it');
    // An em dash cannot survive cmd.exe's code page.
    assert.ok(!/[^\x20-\x7e]/.test(command), 'the command must be plain ASCII');
  });

  it('should_always_plan_regardless_of_any_other_permission_mode', () => {
    // The series may be set to bypassPermissions; this writes a plan, it does
    // not carry one out.
    const command = generateCommand(generatable());

    assert.ok(command.includes('--permission-mode plan'));
    assert.ok(!command.includes('--allow-dangerously-skip-permissions'));
  });

  it('should_omit_the_model_flag_when_no_model_is_pinned', () => {
    assert.ok(!generateCommand(generatable()).includes('--model'));
  });

  it('should_pin_the_model_when_one_is_chosen', () => {
    assert.ok(generateCommand(generatable({ model: 'opus' })).includes('--model opus'));
  });

  it('should_grant_access_to_the_library_that_holds_both_paths', () => {
    // The working directory is the repo; both the task and its staging folder
    // live in the library, outside it. One grant covers both, because `tasks/`
    // and `.pending/` are inside the library — without it Claude can neither
    // read nor write.
    const command = generateCommand(generatable({ sourcePath: TASK, destDir: STAGING }));

    assert.equal(command.match(/--add-dir/g)?.length, 1);
    assert.ok(command.includes(`--add-dir '${LIBRARY}'`));
  });

  it('should_quote_a_path_containing_spaces_for_each_shell', () => {
    const spaced = 'C:\\My Plans';
    const quoted: Record<Shell, string> = {
      powershell: `--add-dir '${spaced}'`,
      cmd: `--add-dir "${spaced}"`,
      posix: `--add-dir '${spaced}'`
    };

    for (const shell of ['powershell', 'cmd', 'posix'] as Shell[]) {
      const command = generateCommand(generatable({ allowDir: spaced, shell }));

      assert.ok(
        command.includes(quoted[shell]),
        `${shell} should wrap the path as ${quoted[shell]}`
      );
    }
  });

  it('should_call_a_quoted_executable_with_the_powershell_call_operator', () => {
    // Without &, PowerShell reads a quoted string at the start of a line as a
    // value rather than a command.
    const exe = 'C:\\Program Files\\claude.exe';
    const command = generateCommand(generatable({ exe, shell: 'powershell' }));

    assert.ok(command.startsWith(`& '${exe}'`));
  });

  it('should_escape_a_single_quote_in_a_posix_path', () => {
    const command = generateCommand(
      generatable({ allowDir: "/home/me/o'brien", shell: 'posix' })
    );

    assert.ok(command.includes(`--add-dir '/home/me/o'\\''brien'`));
  });

  it('should_escape_a_single_quote_in_a_powershell_path', () => {
    const command = generateCommand(
      generatable({ allowDir: "C:\\o'brien", shell: 'powershell' })
    );

    assert.ok(command.includes(`--add-dir 'C:\\o''brien'`));
  });
});

describe('shellKind', () => {
  it('should_treat_pwsh_as_powershell', () => {
    assert.equal(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), 'powershell');
  });

  it('should_treat_cmd_as_cmd', () => {
    assert.equal(shellKind('C:\\WINDOWS\\System32\\cmd.exe', 'win32'), 'cmd');
  });

  it('should_treat_git_bash_on_windows_as_posix', () => {
    // Git Bash and WSL run on Windows but quote like POSIX.
    assert.equal(shellKind('C:\\Program Files\\Git\\bin\\bash.exe', 'win32'), 'posix');
  });

  it('should_treat_any_shell_off_windows_as_posix', () => {
    assert.equal(shellKind('/bin/zsh', 'darwin'), 'posix');
    assert.equal(shellKind('/usr/bin/fish', 'linux'), 'posix');
  });

  it('should_fall_back_to_powershell_for_an_unknown_windows_shell', () => {
    // VS Code's own default profile on Windows.
    assert.equal(shellKind('C:\\tools\\nushell\\nu.exe', 'win32'), 'powershell');
  });
});

describe('preflightError', () => {
  it('should_pass_when_the_plan_and_directory_are_both_present', () => {
    assert.equal(preflightError(launchable(), allExist, readsPlan), undefined);
  });

  it('should_fail_preflight_when_the_plan_file_was_deleted', () => {
    const error = preflightError(launchable(), (p) => p !== PLAN, readsPlan);

    assert.match(String(error), /no longer exists/);
  });

  it('should_fail_preflight_when_the_working_directory_is_gone', () => {
    const error = preflightError(launchable(), (p) => p !== CWD, readsPlan);

    assert.match(String(error), /Working directory/);
  });

  it('should_fail_preflight_when_the_plan_file_is_empty', () => {
    const error = preflightError(launchable(), allExist, () => '   \n\t ');

    assert.match(String(error), /empty/);
  });

  it('should_fail_preflight_when_the_plan_file_cannot_be_read', () => {
    const error = preflightError(launchable(), allExist, () => {
      throw new Error('EACCES');
    });

    assert.match(String(error), /Could not read/);
  });

  it('should_not_read_the_plan_when_it_does_not_exist', () => {
    let reads = 0;
    preflightError(launchable(), () => false, () => {
      reads++;
      return '';
    });

    assert.equal(reads, 0);
  });
});
