/** Source-only video inventory. Fake CDP peers + real codecs are NOT real Chrome evidence.
 * Managed framing, LegacyRecordOnly components, and codec-negative tests stay distinct.
 * Normal tests must stay nonignored in the default harness. */
export const MANAGED_ENCODER_CONTRACTS = [
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::acknowledged_clean_recording_start_refusal_preserves_public_stop_and_scope",
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::recording_start_refusal_cleanup_errors_remain_unknown",
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::recording_start_refusal_missing_cleanup_acks_remain_unknown",
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::recording_start_refusal_encoder_failure_remains_unknown",
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::recording_start_refusal_cancel_and_deadline_remain_unknown",
  "native::client_browser::state_lifecycle_tests::recording_start_receipt_tests::recording_start_refusal_owner_change_and_missing_start_ack_remain_unknown",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::failed_replacement_exports_only_finalized_recording_without_reopening_scope",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::failed_replacement_without_capability_never_exports_frozen_recording",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::failed_replacement_with_stop_error_exports_verified_bytes_without_reopening",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::failed_stop_exports_verified_bytes_without_repeating_stop_or_new_session",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::failed_navigation_exports_real_previous_segment_without_reopening_scope",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::failed_cdp_connection_exports_real_previous_segment_without_reconnect",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::close_before_failed_replacement_result_releases_late_unclaimed_frozen_quota",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::failed_peer_phase_one_still_contains_exact_context_on_terminal_shutdown",
  "native::client_browser::state_lifecycle_tests::terminal_recording_tests::interop_marker_three_create_refusal_joins_recording_and_terminal_close",
] as const;

export const LEGACY_COMPONENT_ENCODER_CONTRACTS = [
  "native::client_actions::tests::recording_wire_contracts::recording_delayed_initial_frame_precedes_ready_and_silent_stop_is_bounded",
  "native::client_actions::tests::recording_wire_contracts::recording_page_opened_remeasures_second_viewport_and_stops_each_capture_once",
  "native::client_actions::tests::recording_wire_contracts::recording_missing_second_file_returns_first_real_segment_without_another_stop",
  "native::client_actions::tests::recording_wire_contracts::recording_freeze_preserves_finished_segment_without_stopping_active_second",
  "native::client_actions::tests::recording_wire_contracts::recording_real_screencast_start_error_disarms_and_joins_without_late_segment"
] as const;

export const ENCODER_NEGATIVE_CONTRACTS = [
  "native::recording::tests::encoder_failure_joins_without_minting_successful_output_proof"
] as const;

export const REQUIRED_VIDEO_NORMAL_TESTS = [
  "native::client_actions::tests::recording_failed_encoder_never_publishes_a_header_only_file",
  "native::client_transport::tests::terminal_artifact_tests::terminal_action_capture_and_connection_failures_preserve_scoped_artifact_lane",
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

export const REQUIRED_ENCODER_CONTRACTS = [...MANAGED_ENCODER_CONTRACTS, ...LEGACY_COMPONENT_ENCODER_CONTRACTS, ...ENCODER_NEGATIVE_CONTRACTS] as const;
