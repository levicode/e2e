/** Full Linux public Web candidate gates, deliberately separate from foundation/release acceptance. */
import { WEB_ACCEPTANCE } from './manifest.ts';

export const CANDIDATE_NATIVE_CONTRACTS = [
  'native::client_browser::tests::chromium_owned_scope_isolation_and_cleanup',
  'native::client_observation::tests::chromium_native_observation_query_exact_and_secure_contract',
  'native::client_observation::tests::chromium_native_same_process_frame_coordinate_convention',
  'native::client_observation::equivalence_tests::chromium_twenty_controls_budget_and_frame_truncation_contract',
  'native::client_observation::equivalence_tests::chromium_embedded_control_and_password_public_labels_contract',
  'native::client_observation::equivalence_tests::chromium_observation_metadata_gc_and_exact_ref_actionability',
  'native::client_observation::equivalence_tests::chromium_query_churn_bounds_durable_metadata_without_evicting_authority',
  'native::client_browser::reference_lifetime_tests::chromium_located_reference_retirement_across_owned_attempts',
  'native::client_observation::equivalence_tests::chromium_observation_retirement_races_are_stale_not_deadline',
  'native::client_observation::equivalence_tests::chromium_exact_read_retirement_races_are_stale_not_deadline',
  'native::client_protected_read::tests::chromium_animation_stabilization_preserves_visibility_and_native_reads',
  'native::client_page::tests::e2e_client_page_input_context_and_evaluate',
  'native::client_actions::tests::chromium_exact_actions_fill_select_check_document_and_stale_ref',
  'native::client_actions::tests::chromium_fixture_query_then_exact_check_without_observation',
  'native::client_actions::tests::chromium_protected_observe_then_exact_check_uses_committed_snapshot',
  'native::client_actions::tests::chromium_protected_pixels_then_exact_check_uses_committed_snapshot',
  'native::client_actions::tests::chromium_replacement_acknowledged_prefix_cancel_preserves_selection_and_session',
  'native::client_capture::tests::chromium_source_masks_cover_dynamic_fields_without_activating_background_page',
  'native::client_actions::tests::chromium_iframe_query_then_exact_check_without_observation',
  'native::client_actions::tests::chromium_nested_frame_action_projects_input_and_checks_exact_ancestor_occlusion',
  'native::client_actions::tests::chromium_recording_attempt_segments_first_frame_size_and_scope_rotation',
  'native::client_enrollment::tests::e2e_enrollment_two_tenants_and_popup_first_script',
  'native::client_enrollment::tests::e2e_managed_blank_initialization_failure_prevents_navigation_request',
  'native::client_enrollment::tests::e2e_popup_initial_request_is_contained_when_configuration_fails',
  'native::client_enrollment::tests::e2e_borrowed_capture_observed_origins_and_native_bootstrap_lifetime',
  'native::client_enrollment::tests::e2e_borrowed_host_survives_detach_and_keeps_unrelated_page',
  'native::client_state::tests::chromium_duplicate_state_records_fail_instead_of_overwriting',
  'native::client_browser::state_lifecycle_tests::chromium_public_state_capture_after_navigation_and_query',
  'native::client_capture::tests::chromium_static_mask_preserves_public_pixels_and_restores_state',
  'native::client_capture::tests::chromium_shared_geometry_masks_transformed_frame_passwords',
  'native::client_capture::equivalence_tests::chromium_capture_retirement_races_publish_no_pixels_and_keep_typed_reason',
  'native::client_geometry::tests::chromium_shared_nested_frame_geometry_border_padding_scroll_and_scale',
  'native::client_geometry::tests::chromium_shared_nested_oopif_geometry_uses_proven_renderer_roots',
  'native::recording::tests::recording_sparse_frames_preserve_timestamps',
  'native::client_observation_dispatch::supersession_tests::chromium_newer_capture_finishes_before_old_metadata_hold_is_manually_released',
  'native::client_observation_dispatch::supersession_tests::chromium_cancelled_newer_admission_preserves_committed_observed_located_and_viewport',
] as const;

/** Not passes or waivers: the independent ingress diagnostic remains outside acceptance. */
export const CANDIDATE_NATIVE_DIAGNOSTICS = [
  'native::client_enrollment::tests::diagnostic_external_direct_url_ingress_precedes_enrollment',
] as const;
export const CANDIDATE_FAULT_FILE = 'semantic-fallback.test.ts';
export const CANDIDATE_SEMANTIC_FAULT_ASSERTIONS = [
  'masked fallback after a stalled semantic reader does not synthesize fallback for a tree-only deadline and permits a fresh read',
  'masked fallback after a stalled semantic reader does not synthesize fallback for a tree-only cancellation and permits a fresh read',
  'masked fallback after a stalled semantic reader reserves capture time and takes fresh masked pixels',
  'masked fallback after a stalled semantic reader keeps abandoned reader IDs distinct from new nodes, frames, and located refs',
  'masked fallback after a stalled semantic reader supersedes a held capture without releasing it and keeps newer refs actionable',
] as const;
export const CANDIDATE_CROSSCHECK_FILE = 'crosscheck.test.ts';
export const CANDIDATE_DIFFERENTIAL_FIXTURES = [
  'shadow section landmarks', 'inferred table headers', 'role fallback tokens', 'boolean attribute casing',
  'inputs', 'buttons and links', 'checked states', 'disabled states', 'expanded and selected',
  'landmarks and headings', 'tables and lists', 'names', 'generated content', 'hidden content', 'shadow and custom elements',
] as const;
export const CANDIDATE_WEB_SUITES = [...WEB_ACCEPTANCE.map(suite => suite.id === 'web-browser' ? { ...suite, prerequisites: [] } : suite), {
  id: 'crosscheck-fixtures', package: 'web', project: 'integration', directory: 'tests/integration',
  requiredFiles: [CANDIDATE_CROSSCHECK_FILE], onlyRequiredFiles: true,
  prerequisites: [], evidence: 'mandatory-native-chrome-playwright-differential-fixtures',
} as const, {
  id: 'package-imports', package: 'e2e', project: 'unit', directory: 'tests/unit',
  requiredFiles: ['package-imports.test.ts'], onlyRequiredFiles: true,
  prerequisites: [], evidence: 'production-dependency-import-guard',
}, {
  id: 'semantic-faults', package: 'web', project: 'integration', directory: 'tests/integration',
  requiredFiles: [CANDIDATE_FAULT_FILE], onlyRequiredFiles: true,
  prerequisites: [], evidence: 'real-browser-acceptance-faults-only',
}] as const;
export const OPTIONAL_CANDIDATE_WEB_SUITES = [{
  id: 'crosscheck-benchmark', package: 'web', project: 'integration', directory: 'tests/integration',
  requiredFiles: [CANDIDATE_CROSSCHECK_FILE], onlyRequiredFiles: true,
  prerequisites: ['CROSSCHECK_BENCHMARK_URL'], evidence: 'optional-local-synthetic-benchmark-sweep',
}] as const;
export type CandidateSuite = (typeof CANDIDATE_WEB_SUITES)[number] | (typeof OPTIONAL_CANDIDATE_WEB_SUITES)[number];
