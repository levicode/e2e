/** Source-only video23 inventory. Fake CDP peers + real codecs are NOT real Chrome evidence.
 * The ten managed-framing tests and three LegacyRecordOnly component tests remain distinct.
 * The ten normal tests must stay nonignored in the default harness. */
export const MANAGED_ENCODER_CONTRACTS = [
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::acknowledged_clean_recording_start_refusal_preserves_public_stop_and_scope",
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::recording_start_refusal_cleanup_errors_remain_unknown",
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::recording_start_refusal_missing_cleanup_acks_remain_unknown",
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::recording_start_refusal_encoder_failure_remains_unknown",
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::recording_start_refusal_cancel_and_deadline_remain_unknown",
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::recording_start_refusal_owner_change_and_missing_start_ack_remain_unknown",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::failed_replacement_exports_only_finalized_recording_without_reopening_scope",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::failed_replacement_without_capability_never_exports_frozen_recording",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::failed_replacement_with_unclean_recording_never_exports_finished_bytes",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::close_before_failed_replacement_result_releases_late_unclaimed_frozen_quota"
] as const;

export const LEGACY_COMPONENT_ENCODER_CONTRACTS = [
  "native::client_actions::tests::recording_wire_contracts::recording_delayed_initial_frame_precedes_ready_and_silent_stop_is_bounded",
  "native::client_actions::tests::recording_wire_contracts::recording_page_opened_remeasures_second_viewport_and_stops_each_capture_once",
  "native::client_actions::tests::recording_wire_contracts::recording_real_screencast_start_error_disarms_and_joins_without_late_segment"
] as const;

export const REQUIRED_VIDEO_NORMAL_TESTS = [
  "native::client_debt::recording_start_status_tests::recording_refusal_requires_exact_error_ack_not_success_or_terminal_status",
  "native::client_terminal_artifacts::tests::terminal_batch_moves_quota_survives_store_close_and_releases_once",
  "native::client_terminal_artifacts::tests::terminal_batch_rejects_foreign_identity_token_handle_and_unknown_fields",
  "native::client_terminal_artifacts::tests::terminal_batch_read_bounds_and_released_handle_never_recreate_bytes",
  "native::client_terminal_artifacts::tests::frozen_quota_rejects_mixed_authority_retired_and_closed_stores",
  "native::client_transport::tests::terminal_artifact_tests::terminal_artifact_duplicate_id_under_writer_backpressure_never_steals_original_receipt",
  "native::client_transport::tests::terminal_artifact_tests::terminal_artifact_foreign_generation_reused_sequence_callback_and_schema_are_not_admitted",
  "native::client_transport::tests::terminal_artifact_tests::terminal_artifact_traffic_never_renews_original_ten_second_cutoff",
  "native::client_transport::tests::terminal_artifact_tests::terminal_artifact_commands_never_enter_ordinary_executor_dispatch",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::poisoned_terminal_recording_custody_never_proves_closed"
] as const;

export const REQUIRED_ENCODER_CONTRACTS = [...MANAGED_ENCODER_CONTRACTS, ...LEGACY_COMPONENT_ENCODER_CONTRACTS] as const;
