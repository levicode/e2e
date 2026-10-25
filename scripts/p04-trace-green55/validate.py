#!/usr/bin/env python3
"""Fifty-five exact regression fixtures against a production-fix source; all must PASS.
No production build, browser run, acceptance retirement or release proof.
"""
import hashlib, json, os, re, signal, subprocess, sys, tempfile, time
from pathlib import Path
HERE=Path(__file__).resolve().parent
EXPECTED_CASES=[{'name': 'native::client_browser::state_lifecycle_tests::observe_trace_timeout_tests::observe_peer_ax_schema_and_omitted_flags_match_real_protocol', 'configuration': 'faults', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_browser_observe_trace_timeout_tests.rs', 'id': 'case-01', 'category': 'control'}, {'name': 'native::client_browser::state_lifecycle_tests::observe_trace_timeout_tests::observe_pointer_trace_immediate_positive', 'configuration': 'faults', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_browser_observe_trace_timeout_tests.rs', 'id': 'case-02', 'category': 'control'}, {'name': 'native::client_browser::state_lifecycle_tests::trace_cleanup_tests::trace_timeout_immediate_positive_closes_borrowed_scope', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_browser_trace_cleanup_tests.rs', 'id': 'case-03', 'category': 'control'}, {'name': 'native::client_browser::state_lifecycle_tests::observe_trace_timeout_tests::observe_pointer_trace_native_deadline_records_then_checks_contract', 'configuration': 'faults', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_browser_observe_trace_timeout_tests.rs', 'id': 'case-04', 'category': 'regression'}, {'name': 'native::client_browser::state_lifecycle_tests::observe_trace_timeout_tests::observe_pointer_trace_client_cancel_ack_records_then_checks_contract', 'configuration': 'faults', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_browser_observe_trace_timeout_tests.rs', 'id': 'case-05', 'category': 'regression'}, {'name': 'native::client_browser::state_lifecycle_tests::trace_cleanup_tests::trace_timeout_late_reply_keeps_source_until_terminal_and_closes_scope', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_browser_trace_cleanup_tests.rs', 'id': 'case-06', 'category': 'regression'}, {'name': 'native::client_browser::state_lifecycle_tests::trace_cleanup_tests::trace_timeout_rate_restore_rejection_remains_hard_failure', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_browser_trace_cleanup_tests.rs', 'id': 'case-07', 'category': 'regression'}, {'name': 'native::client_browser::state_lifecycle_tests::trace_cleanup_tests::trace_timeout_without_continuation_negotiation_stays_quarantined', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_browser_trace_cleanup_tests.rs', 'id': 'case-08', 'category': 'regression'}, {'name': 'native::client_browser::state_lifecycle_tests::trace_cleanup_tests::trace_timeout_pending_scope_end_waits_for_terminal_cleanup', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_browser_trace_cleanup_tests.rs', 'id': 'case-09', 'category': 'regression'}, {'name': 'native::client_browser::state_lifecycle_tests::trace_cleanup_tests::trace_never_terminal_shares_cleanup_cap_and_retains_borrowed_owner', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_browser_trace_cleanup_tests.rs', 'id': 'case-10', 'category': 'regression'}, {'name': 'native::client_protected_read::tests::residual_poisoned_records_survive_journal_drop', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_protected_read.rs', 'id': 'case-11', 'category': 'regression'}, {'name': 'native::client_protected_read::tests::residual_expired_cleanup_deadline_sends_no_restore_commands', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_protected_read.rs', 'id': 'case-12', 'category': 'regression'}, {'name': 'native::client_protected_read::tests::residual_group_release_failure_keeps_removed_stage', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_protected_read.rs', 'id': 'case-13', 'category': 'regression'}, {'name': 'native::client_protected_read::tests::residual_owner_binding_rejects_other_client_generation_and_ledger_change', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_protected_read.rs', 'id': 'case-14', 'category': 'regression'}, {'name': 'native::client_protected_read::tests::residual_drop_keeps_exact_coordinates_and_refuses_next_read', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_protected_read.rs', 'id': 'case-15', 'category': 'regression'}, {'name': 'native::client_protected_read::tests::residual_partial_failure_preserves_acknowledged_and_unresolved_steps', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_protected_read.rs', 'id': 'case-16', 'category': 'regression'}, {'name': 'native::client_protected_read::tests::residual_empty_drop_and_complete_restore_release_only_exact_slot', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_protected_read.rs', 'id': 'case-17', 'category': 'regression'}, {'name': 'native::client_enrollment::tests::protected_residual_owned_disposal_requires_exact_ack_and_context', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_enrollment.rs', 'id': 'case-18', 'category': 'regression'}, {'name': 'native::client_enrollment::tests::protected_residual_rejected_disposal_keeps_custody', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_enrollment.rs', 'id': 'case-19', 'category': 'regression'}, {'name': 'native::client_enrollment::tests::protected_residual_missing_disposal_ack_keeps_custody', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_enrollment.rs', 'id': 'case-20', 'category': 'regression'}, {'name': 'native::client_enrollment::tests::protected_residual_destroyed_remains_distinct_from_later_release_failure', 'configuration': 'default', 'expected': 'passed', 'sourceFile': 'cli/src/native/client_enrollment.rs', 'id': 'case-21', 'category': 'regression'}, {'id': 'case-22', 'name': 'native::client_actions::tests::retirement_node_swipes::node400x300_blocked_preaim_down_then_fast_left_waits_for_each_render', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-23', 'name': 'native::client_actions::tests::retirement_node_swipes::node400x300_clear_centre_moves200_150_before_down150', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-24', 'name': 'native::client_actions::tests::retirement_node_swipes::node400x300_pointer80_70_is_recentered_policy_counterexample', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-25', 'name': 'native::client_actions::tests::pointer_original_down_swipe_800x600_waits_for_post_wheel_render_ack', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-26', 'name': 'native::client_actions::tests::legacy_locator_dispatch::locator_clear_uses_exact_empty_value_then_fallback_delete', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-27', 'name': 'native::client_observation::composition_tests::union_frame_paths_are_exact_and_stripped_before_matching', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-28', 'name': 'native::client_observation_dispatch::composition_tests::unsupported_composition_never_dispatches_cdp_or_stages_references', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-29', 'name': 'native::client_observation::composition_tests::union_is_plain_and_composable_even_with_exact_label_visible_branches', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-30', 'name': 'native::client_observation::composition_tests::display_value_scope_and_has_refuse_through_every_refinement', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-31', 'name': 'native::client_observation::tests::private_query_payload_preserves_false_states_independent_of_public_projection', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-32', 'name': 'native::client_observation::tests::public_glyph_names_preserve_real_text_and_security_boundaries', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-33', 'name': 'native::client_observation::tests::recognized_authored_roles_survive_absent_or_demoted_ax_without_rebinding', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-34', 'name': 'native::client_actions::tests::preparation_effect_settlement_unacked_input_release_remains_unknown', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-35', 'name': 'native::client_actions::tests::recording_unarmed_page_hooks_and_stop_are_resource_free_noops', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-36', 'name': 'native::client_observation_dispatch::supersession_tests::mask_failure_tests::detached_mask_probe_preserves_original_semantic_timeout_without_pixels', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-37', 'name': 'native::client_observation_dispatch::supersession_tests::mask_failure_tests::detached_mask_reader_exception_has_typed_independent_coverage_provenance', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-38', 'name': 'native::client_observation_dispatch::supersession_tests::mask_failure_tests::rejected_mask_probe_does_not_hide_browser_failure_behind_semantic_timeout', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-39', 'name': 'native::client_observation_dispatch::supersession_tests::mask_failure_tests::rejected_mask_reader_command_remains_typed_browser_failure', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-40', 'name': 'native::client_actions::tests::direct_point_clicks::direct_point_original_tap_at_10_20', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-41', 'name': 'native::client_actions::tests::direct_point_clicks::direct_point_original_double_tap_at_10_20', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-42', 'name': 'native::client_actions::tests::direct_point_clicks::direct_point_original_secondary_tap_at_10_20', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-43', 'name': 'native::client_actions::tests::direct_point_clicks::direct_point_original_long_press_at_10_20_holds_700_ms', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-44', 'name': 'native::client_actions::tests::direct_point_clicks::direct_point_original_fractional_tap_and_swipe_round_to_css_pixels', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-45', 'name': 'native::client_actions::tests::direct_point_clicks::direct_point_original_swipe_to_110_20_uses_midpoint', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-46', 'name': 'native::client_actions::tests::direct_point_clicks::direct_point_original_swipe_to_70_20_cancel_after_first_move_releases_once', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-47', 'name': 'native::client_actions::tests::legacy_locator_dispatch::locator_long_press_witnesses_original_900_ms_hold', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-48', 'name': 'native::client_actions::tests::legacy_locator_dispatch::locator_select_option_positive_index_two_executes_native_selection', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-49', 'name': 'native::client_actions::tests::live_drag_destination_revalidates_after_press_without_replay', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-50', 'name': 'native::client_actions::tests::observed_drag_destination_keeps_exact_identity_after_press', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-51', 'name': 'native::client_actions::tests::select_modes_are_unambiguous_and_string_means_label', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-52', 'name': 'native::client_actions::tests::recording_failed_stop_keeps_valid_file_and_reports_missing_once', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-53', 'name': 'native::client_actions::tests::recording_abandon_joins_and_prevents_late_page_segments', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-54', 'name': 'native::client_observation::composition_tests::display_value_query_resets_provenance_and_preserves_allowed_refinements', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}, {'id': 'case-55', 'name': 'native::client_actions::tests::live_query_publication_then_tap_refuses_ambiguity_without_input', 'configuration': 'default', 'expected': 'passed', 'category': 'retirement-regression'}]
PINS=json.loads((HERE/os.environ.get('P04_PINS_FILE','pins.json' if (HERE/'pins.json').exists() else 'pins.template.json')).read_text())
EVIDENCE=Path(os.environ.get('EVIDENCE_DIR','.'))
ACTIVE_GROUPS=set()
COMPILE_PHASES=['recipe-identity','source-before','source-patch','toolchain','format','clippy','acceptance-tests-check','proxy-feature-check','default-harness-compile','default-harness-inventory','faults-harness-compile','faults-harness-inventory']

def terminate_owned(signum, _frame):
    for group in tuple(ACTIVE_GROUPS):
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    raise SystemExit(128 + signum)

def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def execute(name, seconds, command):
    """Keep the real exit and timeout; reap only this command's owned process group."""
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    result = {'command': command, 'exit': None, 'timed_out': False}
    save(EVIDENCE / f'{name}.command.json', command)
    started = time.monotonic()
    with (EVIDENCE / f'{name}.stdout.log').open('w') as out, (EVIDENCE / f'{name}.stderr.log').open('w') as err:
        try:
            with subprocess.Popen(command, stdout=out, stderr=err, start_new_session=True) as process:
                ACTIVE_GROUPS.add(process.pid)
                try:
                    process.wait(timeout=seconds)
                except subprocess.TimeoutExpired:
                    result['timed_out'] = True
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                finally:
                    ACTIVE_GROUPS.discard(process.pid)
                result['exit'] = process.returncode
        except OSError as error:
            result['error'] = str(error)
        except (SystemExit, KeyboardInterrupt) as error:
            result['interrupted'] = True
            result['exit'] = error.code if isinstance(error, SystemExit) else 130
    result['elapsed_seconds'] = round(time.monotonic() - started, 3)
    status = 124 if result['timed_out'] else result['exit']
    if status is None:
        status = 127
    (EVIDENCE / f'{name}.exit').write_text(f'{status}\n')
    save(EVIDENCE / f'{name}.result.json', result)
    for kind in ('stdout', 'stderr'):
        print((EVIDENCE / f'{name}.{kind}.log').read_text(errors='replace'), end='', flush=True)
    print(f"{name}: exit={status}; timed_out={result['timed_out']}", flush=True)
    if result.get('interrupted'):
        raise SystemExit(status)
    return status

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()

def source_identity(root, applied):
    validate_pins()
    root = Path(root).resolve()
    assert git(root, 'rev-parse', 'HEAD') == PINS['publishedNativeSha']
    parents = [line[7:] for line in git(root, 'cat-file', '-p', 'HEAD').splitlines() if line.startswith('parent ')]
    assert parents == [PINS['baseNativeSha']], 'Source commit must have exactly the reviewed formal7932 base parent'
    assert git(root, 'rev-parse', 'HEAD^1^{tree}') == PINS['baseNativeTree']
    assert git(root, 'rev-parse', 'HEAD^{tree}') == PINS['candidateTree']
    assert digest(root / 'cli/Cargo.lock') == PINS['nativeLockSha256']
    assert not git(root, 'status', '--porcelain', '--untracked-files=all'), 'Source checkout must remain pristine'
    ignored = subprocess.check_output(['git','-C',str(root),'ls-files','--others','--ignored','--exclude-standard'],text=True).splitlines()
    placeholder='packages/dashboard/out/index.html'
    assert ignored in ([],[placeholder]), 'Unexpected ignored source/build input'
    if ignored:
        assert (root/placeholder).read_bytes()==b'<!DOCTYPE html><html><body><p>Dashboard not built. Run: cd packages/dashboard &amp;&amp; pnpm build</p></body></html>\n'
    assert git(root, 'write-tree') == PINS['candidateTree']
    assert git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD').splitlines() == [row['path'] for row in PINS['changedFiles']]
    for row in PINS['changedFiles']:
        assert digest(root / row['path']) == row['afterSha256']
        exists = subprocess.run(['git', '-C', str(root), 'cat-file', '-e', 'HEAD^1:' + row['path']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        assert exists == (row['beforeSha256'] is not None), 'Base file presence mismatch'
        if exists:
            data = subprocess.check_output(['git', '-C', str(root), 'show', 'HEAD^1:' + row['path']])
            assert hashlib.sha256(data).hexdigest() == row['beforeSha256']
    return {'publishedHead': PINS['publishedNativeSha'], 'baseHead': PINS['baseNativeSha'], 'baseTree': PINS['baseNativeTree'], 'effectiveTree': PINS['candidateTree'], 'onlyTestOverlay': False, 'productionSourceChanged': True, 'lockSha256': PINS['nativeLockSha256']}

def apply_overlay(root):
    # Source changes are already committed. Reverse the complete patch in a
    # private index to the exact formal7932 base, never to an older formal baseline.
    source_identity(root, False)
    patch = HERE / 'source-change.patch'
    assert digest(patch) == PINS['patchSha256']
    with tempfile.TemporaryDirectory(prefix='native-terminal-source-patch-') as temporary:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / 'index'))
        command = ['git', '-C', str(root)]
        subprocess.run(command + ['read-tree', PINS['baseNativeTree']], env=env, check=True)
        subprocess.run(command + ['apply', '--cached', '--check', '--whitespace=error', str(patch)], env=env, check=True)
        subprocess.run(command + ['apply', '--cached', '--whitespace=error', str(patch)], env=env, check=True)
        assert subprocess.check_output(command + ['write-tree'], env=env, text=True).strip() == PINS['candidateTree']
        subprocess.run(command + ['apply', '--cached', '--reverse', '--check', '--whitespace=error', str(patch)], env=env, check=True)
        subprocess.run(command + ['apply', '--cached', '--reverse', '--whitespace=error', str(patch)], env=env, check=True)
        assert subprocess.check_output(command + ['write-tree'], env=env, text=True).strip() == PINS['baseNativeTree']
    value = source_identity(root, True)
    value.update(patchSha256=PINS['patchSha256'], patchInputs=PINS['patchInputs'], productionSourceChanged=True, forwardPatchMatchesCandidateTree=True, reversePatchRestoresExactBaseTree=True)
    save(EVIDENCE / 'source-patch-identity.json', value)

def capture_harness(root, configuration):
    validate_cases()
    config = PINS['configurations'][configuration]
    phase = configuration + '-harness-compile'
    selected = [case for case in PINS['cases'] if case['configuration'] == configuration]
    root = Path(root).resolve()
    source_identity(root, True)
    assert (EVIDENCE / (phase + '.exit')).read_text().strip() == '0'
    rows = [json.loads(line) for line in (EVIDENCE / (phase + '.stdout.log')).read_text().splitlines() if line.strip()]
    finished = [row for row in rows if row.get('reason') == 'build-finished']
    assert len(finished) == 1 and finished[0].get('success') is True
    artifacts = [row for row in rows if row.get('reason') == 'compiler-artifact' and row.get('executable')]
    assert len(artifacts) == 1, 'Only the selected unit-test harness is allowed'
    row = artifacts[0]
    assert row['target']['name'] == 'agent-browser' and row['target']['kind'] == ['bin']
    assert row['target']['src_path'] == str(root / 'cli/src/main.rs') and row['manifest_path'] == str(root / 'cli/Cargo.toml')
    assert row['features'] == config['features'] and row['profile']['test'] is True
    assert row['profile']['opt_level'] == '0' and row['profile']['debug_assertions'] is True
    binary = Path(row['executable']).resolve(strict=True)
    assert binary.parent == Path(os.environ['CARGO_TARGET_DIR']).resolve() / config['targetDirectory']
    assert binary.is_file() and os.access(binary, os.X_OK)
    with binary.open('rb') as stream:
        header = stream.read(20)
    assert header[:6] == bytes.fromhex('7f454c460201') and int.from_bytes(header[18:20], 'little') == 62
    before = digest(binary)
    status = execute('list-' + configuration + '-harness', 60, [str(binary), '--list', '--format', 'pretty', '--color', 'never'])
    output = (EVIDENCE / ('list-' + configuration + '-harness.stdout.log')).read_text()
    inventory = re.findall(r'(?m)^(.+): test$', output)
    assert status == 0 and len(inventory) == len(set(inventory))
    for case in selected:
        assert inventory.count(case['name']) == 1, f"Exact test missing: {case['name']}"
    if configuration == 'default':
        assert not any(case['name'] in inventory for case in PINS['cases'] if case['configuration'] == 'faults'), 'Feature-gated tests appeared in default harness'
    assert before == digest(binary)
    save(EVIDENCE / (configuration + '-harness-binding.json'), {'binary': str(binary), 'sha256': before, 'cargoArtifact': row, 'source': source_identity(root, True), 'inventory': inventory, 'selectedExactTests': selected, 'configuration': configuration, 'features': config['features'], 'cargoProfile': 'dev', 'productionImageBuilt': False})

def verify_binding(binding, configuration):
    validate_cases()
    expected = {'publishedHead': PINS['publishedNativeSha'], 'baseHead': PINS['baseNativeSha'], 'baseTree': PINS['baseNativeTree'], 'effectiveTree': PINS['candidateTree'], 'onlyTestOverlay': False, 'productionSourceChanged': True, 'lockSha256': PINS['nativeLockSha256']}
    assert binding['source'] == expected, 'Harness source binding mismatch'
    assert binding['selectedExactTests'] == [row for row in PINS['cases'] if row['configuration'] == configuration]
    assert binding['configuration'] == configuration and binding['features'] == PINS['configurations'][configuration]['features'] and binding['cargoProfile'] == 'dev'

def verify_saved_case(case):
    saved = json.loads((EVIDENCE / (case['id'] + '.ledger.json')).read_text())
    binding = json.loads((EVIDENCE / (case['configuration'] + '-harness-binding.json')).read_text())
    verify_binding(binding, case['configuration'])
    result = json.loads((EVIDENCE / (case['id'] + '.result.json')).read_text())
    command = [binding['binary'], '--exact', case['name'], '--test-threads=1', '--format', 'pretty', '--color', 'never']
    assert result['command'] == command and saved['command'] == command
    assert saved['harnessSha256Before'] == saved['harnessSha256After'] == binding['sha256']
    actual = inspect_case(case, (EVIDENCE / (case['id'] + '.stdout.log')).read_text(), (EVIDENCE / (case['id'] + '.stderr.log')).read_text(), result, binding['sha256'], saved['harnessSha256After'])
    assert all(saved[key] == value for key, value in actual.items()), 'Ledger does not match raw evidence'
    return actual

def validate_cases():
    encoded=json.dumps(PINS['cases'],sort_keys=True,separators=(',',':')).encode()
    assert PINS.get('casesFrozen') is True and hashlib.sha256(encoded).hexdigest()==PINS['casesSha256']
    assert PINS['cases']==EXPECTED_CASES, 'Exact approved 55 cases changed'
    assert len(PINS['cases'])==55 and len({c['name'] for c in PINS['cases']})==55
    assert all(c['expected']=='passed' for c in PINS['cases'])
    assert sum(c['configuration']=='default' for c in PINS['cases'])==51
    assert sum(c['configuration']=='faults' for c in PINS['cases'])==4
    assert PINS['configurations']=={'default':{'features':[],'profile':'dev','targetDirectory':'debug/deps'},'faults':{'features':['acceptance-faults'],'profile':'dev','targetDirectory':'debug/deps'}}
    assert PINS['redSources']=={}

def validate_pins():
    assert PINS.get('enabled') is True and PINS.get('sourceBindingFrozen') is True, 'UNRESOLVED source binding'
    validate_cases()
    assert PINS['baseNativeSha']=='7932b596b654dfbb3731679321e613e37944c4c2'
    assert PINS['baseNativeTree']=='23d4de87258f4635e92abdc5b554d278f5a20f8a'
    for key in ('publishedNativeSha','candidateTree'):
        assert re.fullmatch('[0-9a-f]{40}',PINS[key] or '')
    assert PINS['onlyTestOverlay'] is False and PINS['productionSourceChanged'] is True and PINS['productionImageBuilt'] is False
    assert [f['path'] for f in PINS['changedFiles']]==['cli/src/native/client_browser.rs', 'cli/src/native/client_browser_observe_trace_timeout_tests.rs', 'cli/src/native/client_browser_state_tests.rs', 'cli/src/native/client_browser_trace_cleanup_tests.rs', 'cli/src/native/client_capture.rs', 'cli/src/native/client_enrollment.rs', 'cli/src/native/client_observation_dispatch.rs', 'cli/src/native/client_protected_read.rs', 'cli/src/native/client_protected_read_residual.rs', 'cli/src/native/client_targets.rs', 'cli/src/native/mod.rs']
    assert digest(HERE/'source-change.patch')==PINS['patchSha256']
    assert PINS['rustVersion']=='1.99.1' and PINS['stackBytes']==16777216
    assert PINS['cargoBuildJobs']==2 and PINS['perCaseSeconds']==120

def inspect_case(case, stdout, stderr, result, harness_sha, post_sha):
    outcomes=re.findall(r'(?m)^test (\S+) \.\.\. (ok|ignored(?:, [^\n]*)?|FAILED)$',stdout)
    summaries=re.findall(r'(?m)^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in [0-9.]+s$',stdout)
    actual='unknown'
    if len(summaries)==len(outcomes)==1 and outcomes[0][0]==case['name'] and re.findall(r'(?m)^running (\d+) tests?$',stdout)==['1']:
        word,passed,failed,ignored,measured,_filtered=summaries[0]
        if ignored==measured=='0' and not result.get('timed_out') and not result.get('interrupted') and harness_sha==post_sha:
            if word=='ok' and (passed,failed)==('1','0') and outcomes[0][1]=='ok' and result.get('exit')==0 and ' panicked at ' not in stdout+stderr: actual='passed'
            elif word=='FAILED' and (passed,failed)==('0','1') and outcomes[0][1]=='FAILED' and result.get('exit')==101: actual='failed'
    proof=None
    expected_observed=(case['expected']=='passed' and actual=='passed') or proof is not None
    classification='expected-pass-observed' if case['expected']=='passed' and actual=='passed' else 'expected-red-observed' if proof else 'unexpected-pass' if actual=='passed' else 'unexpected-failure' if actual=='failed' else 'unknown'
    return {'id':case['id'],'test':case['name'],'category':case['category'],'expected':case['expected'],'actual':actual,
            'configuration':case['configuration'],'features':PINS['configurations'][case['configuration']]['features'],
            'expectedObservationConfirmed':expected_observed,'testPassed':actual=='passed','classification':classification,'targetRedEvidence':proof,
            'process':result,'harnessSha256Before':harness_sha,'harnessSha256After':post_sha,'sourceTree':PINS['candidateTree'],
            'originalE2eRetired':False,'fullNativeSuitePassed':False,'productionAcceptance':False}

def run_case(case_id):
    validate_pins()
    assert all((EVIDENCE/(p+'.exit')).read_text().strip()=='0' for p in COMPILE_PHASES), 'All strict gates and harness phases must pass before tests'
    case=next(row for row in PINS['cases'] if row['id']==case_id)
    for prerequisite in [c for c in PINS['cases'][:PINS['cases'].index(case)] if c['expected']=='passed']:
        positive=verify_saved_case(prerequisite)
        assert prerequisite['expected']=='passed' and positive['actual']=='passed' and positive['expectedObservationConfirmed'], 'Every earlier exact positive control must actually pass first'
    binding=json.loads((EVIDENCE/(case['configuration']+'-harness-binding.json')).read_text())
    verify_binding(binding,case['configuration'])
    binary=Path(binding['binary']); assert digest(binary)==binding['sha256']
    command=[str(binary),'--exact',case['name'],'--test-threads=1','--format','pretty','--color','never']
    execute(case_id,120,command)
    result=json.loads((EVIDENCE/f'{case_id}.result.json').read_text())
    receipt=inspect_case(case,(EVIDENCE/f'{case_id}.stdout.log').read_text(),(EVIDENCE/f'{case_id}.stderr.log').read_text(),result,binding['sha256'],digest(binary))
    receipt['command']=command
    save(EVIDENCE/f'{case_id}.ledger.json',receipt)
    # Preserve actual failures; no expected-RED exemption exists in GREEN.
    return 0 if receipt['expectedObservationConfirmed'] else 1

def summarize():
    validate_pins()
    phases=COMPILE_PHASES+['source-after-pure']
    states={p:(EVIDENCE/(p+'.exit')).read_text().strip() if (EVIDENCE/(p+'.exit')).exists() else 'missing' for p in phases}
    cases=[]
    for case in PINS['cases']:
        try: cases.append(verify_saved_case(case))
        except (OSError,ValueError,KeyError,AssertionError): cases.append({'id':case['id'],'actual':'unknown','testPassed':False,'expectedObservationConfirmed':False})
    observed=all(v=='0' for v in states.values()) and all(c['expectedObservationConfirmed'] for c in cases) and [c['actual'] for c in cases]==['passed']*55
    value={'targetedGreenObserved':observed,'allTestsPassed':all(c['actual']=='passed' for c in cases),'nativeSha':PINS['publishedNativeSha'],'nativeTree':PINS['candidateTree'],
           'runId':int(os.environ['GITHUB_RUN_ID']),'runAttempt':int(os.environ['GITHUB_RUN_ATTEMPT']),'recipeSha':os.environ['GITHUB_WORKFLOW_SHA'],
           'passedTestCount':sum(c['actual']=='passed' for c in cases),'failedTestCount':sum(c['actual']=='failed' for c in cases),'unknownTestCount':sum(c['actual']=='unknown' for c in cases),
           'selectedCaseCount':55,'phases':states,'cases':cases,'productionImageBuilt':False,'fullNativeSuitePassed':False,'originalE2eRetired':False,
           'scope':'55 targeted GREEN regressions against production-fix source; not full native or original browser P04 acceptance'}
    save(EVIDENCE/'p04-trace-verified.json',value)
    return 0 if observed else 1

def main():
    mode,*args=sys.argv[1:]
    if mode=='run': return execute(args[0],int(args[1]),args[2:])
    if mode=='guard':
        validate_pins()
        values={'NATIVE_SHA':PINS['publishedNativeSha'],'NATIVE_TREE':PINS['candidateTree'],'NATIVE_LOCK_SHA256':PINS['nativeLockSha256']}
        with open(os.environ['GITHUB_ENV'],'a') as stream:
            for k,v in values.items(): stream.write(f'{k}={v}\n')
    elif mode=='recipe':
        validate_pins(); root=Path(args[0]); assert git(root,'rev-parse','HEAD')==args[1] and not git(root,'status','--porcelain')
        save(EVIDENCE/'recipe-binding.json',{'commit':args[1],'tree':git(root,'rev-parse','HEAD^{tree}'),'helperSha256':digest(Path(__file__)),'pinsSha256':digest(HERE/'pins.json'),'patchSha256':digest(HERE/'source-change.patch')})
    elif mode=='source':
        if len(args)>1 and args[1]=='pristine': assert not git(args[0],'ls-files','--others','--ignored','--exclude-standard'), 'Initial source contains ignored input'
        print(json.dumps(source_identity(args[0],True)))
    elif mode=='apply': apply_overlay(args[0])
    elif mode=='harness': capture_harness(args[0],args[1])
    elif mode=='case': return run_case(args[0])
    elif mode=='summary': return summarize()
    elif mode=='aggregate':
        states={p:(EVIDENCE/(p+'.exit')).read_text().strip() for p in args}
        verified=json.loads((EVIDENCE/'p04-trace-verified.json').read_text())
        accepted=all(v=='0' for v in states.values()) and verified['targetedGreenObserved'] and verified['passedTestCount']==55 and verified['failedTestCount']==0
        save(EVIDENCE/'aggregate.json',{'targetedGreenObserved':accepted,'phases':states,'allTestsPassed':verified['allTestsPassed'],'productionImageBuilt':False,'releaseEligible':False})
        assert accepted
    else: raise AssertionError('Only closed targeted regression recipe modes are supported')
    return 0
if __name__=='__main__':
    signal.signal(signal.SIGTERM,terminate_owned); signal.signal(signal.SIGINT,terminate_owned)
    sys.exit(main())
