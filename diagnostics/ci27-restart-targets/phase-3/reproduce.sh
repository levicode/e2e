#!/usr/bin/env bash
set -euo pipefail
source /workspace/e2e/.artifacts/native-candidate/run.env
export CARGO_TARGET_DIR=/workspace/e2e/.artifacts/restart-native-target
export PLAYWRIGHT_BROWSERS_PATH=/workspace/e2e/.artifacts/system-chromium-diagnostic
out=/workspace/e2e/.artifacts/restart-readiness-evidence
root=/workspace/e2e/.artifacts/restart-diagnostic-e2e
native=/workspace/e2e/.artifacts/restart-readiness-native
expected=fce932e38faced7af762dabe4bd45f4ab9f633c5
test "$(git -C "$native" rev-parse HEAD)" = "$expected"
test -z "$(git -C "$native" status --porcelain)"
cd "$root"
case "${1:?probe|fault-probe|units|baseline|p33|p34}" in
  probe)
    python3 "$out/run-browser-stage.py" readiness-negotiation "$root" - node scripts/acceptance/probe-native.ts "$out/production" "$out/required-capabilities.json" "$out/negotiation.json"
    ;;
  fault-probe)
    python3 "$out/run-browser-stage.py" readiness-fault-negotiation "$root" - node scripts/acceptance/probe-native.ts "$out/acceptance-faults" "$out/fault-capabilities.json" "$out/fault-negotiation.json"
    ;;
  units)
    prefix=native::client_enrollment::tests::restart_readiness
    python3 "$out/run-stage.py" readiness-exact-units "$root" - node .artifacts/native-candidate/focused-native.mts "$native" "$expected" "$CARGO_TARGET_DIR" "$out/compiler.jsonl" "$out/units" \
      "$prefix::all_observed_sibling_acks_are_required_without_kind_exemptions" \
      "$prefix::child_received_after_first_ready_check_blocks_final_publication" \
      "$prefix::held_ack_obeys_original_cancellation_and_deadline" \
      "$prefix::held_ack_failure_preserves_cause_and_cannot_publish" \
      "$prefix::stored_failure_precedes_its_secondary_stop_cancellation" \
      "$prefix::seal_wakes_waiter_and_never_becomes_a_pending_configuration" \
      "$prefix::unknown_inventory_and_same_id_reattachment_refuse_without_publication" \
      native::cdp::client::tests::exact_tap_publication_fence_retains_reader_admission_lock \
      native::client_restart::tests::restart_replaces_only_pages_and_keeps_context_worker_and_route_tenure \
      native::client_restart::tests::explicit_persistent_restart_closes_context_pages_without_adopting_host_pages \
      native::client_restart::tests::restart_failure_preserves_exact_close_or_create_ownership_without_success_proof
    ;;
  baseline)
    python3 "$out/run-stage.py" readiness-default-baseline "$root" - node scripts/acceptance/candidate-native.ts baseline "$native" "$CARGO_TARGET_DIR" "$out/compiler.jsonl" "$out/default" "$expected"
    ;;
  p33|p34)
    mode=$1
    id="restart-readiness-$mode-${2:?unique-round}"
    test ! -e "$root/.artifacts/native-candidate/$id/focused.result.json"
    name='round-trips persisted state through capture and restore, and reset drops it'
    if test "$mode" = p34; then name='records a video per page at the viewport size: a restart and a state reset each continue in a new segment'; fi
    python3 "$out/run-browser-stage.py" "$id" "$root" - node .artifacts/native-candidate/focused-vitest.mts "$id" "$native" "$expected" "$out/production" "$out/negotiation.json" tests/integration/lifecycle.test.ts "$name" "$out/acceptance-faults" "$out/fault-negotiation.json"
    ;;
  *) exit 2 ;;
esac
