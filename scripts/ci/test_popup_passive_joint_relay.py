"""Pure controls: no browser, listening socket, native process or CDP injection."""
import asyncio
import importlib.util
import json
import pathlib
import stat
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).with_name("popup-passive-joint-relay.py")
SPEC = importlib.util.spec_from_file_location("popup_passive_joint_relay", SOURCE)
relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(relay)


class PassiveMetadataControls(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.directory.name, "evidence.jsonl")
        self.metadata = relay.Metadata(self.path)

    def tearDown(self):
        self.metadata.finish()
        self.directory.cleanup()

    def send(self, connection, outbound, message):
        self.metadata.observe(connection, outbound, json.dumps(message))

    def records(self):
        return [json.loads(line) for line in self.metadata.lines]

    def attach(self, connection, session, target="RAW-TARGET", context="RAW-CONTEXT"):
        self.send(connection, False, {"method": "Target.attachedToTarget", "params": {
            "sessionId": session, "waitingForDebugger": True, "targetInfo": {
                "targetId": target, "browserContextId": context, "type": "page", "openerId": "RAW-OPENER",
                "url": "https://NEVER-OUTPUT.invalid/?TOKEN", "title": "NEVER-OUTPUT-TITLE"}}})

    def test_shared_target_frame_loader_and_default_unique_context_across_connections(self):
        first, second = self.metadata.connection(), self.metadata.connection()
        for connection, session in ((first, "RAW-SESSION-ONE"), (second, "RAW-SESSION-TWO")):
            self.attach(connection, session)
            self.send(connection, False, {"method": "Page.frameNavigated", "sessionId": session, "params": {
                "frame": {"id": "RAW-FRAME", "loaderId": "RAW-LOADER", "url": "https://NEVER-OUTPUT.invalid/"}}})
            self.send(connection, False, {"method": "Runtime.executionContextCreated", "sessionId": session, "params": {
                "context": {"id": 7, "uniqueId": "RAW-UNIQUE", "origin": "NEVER-OUTPUT-ORIGIN", "name": "NEVER-OUTPUT-NAME",
                            "auxData": {"frameId": "RAW-FRAME", "isDefault": True, "type": "default"}}}})
        attached = [record for record in self.records() if record["kind"] == "attached"]
        self.assertEqual(attached[0]["targetOrdinal"], attached[1]["targetOrdinal"])
        self.assertEqual(attached[0]["contextOrdinal"], attached[1]["contextOrdinal"])
        self.assertNotEqual(attached[0]["sessionOrdinal"], attached[1]["sessionOrdinal"])
        contexts = [record for record in self.records() if record["kind"] == "context"]
        self.assertEqual(contexts[0]["uniqueContextOrdinal"], contexts[1]["uniqueContextOrdinal"])
        frames = [record for record in self.records() if record["kind"] == "frame"]
        self.assertEqual(frames[0]["frameOrdinal"], frames[1]["frameOrdinal"])
        self.assertEqual(frames[0]["loaderOrdinal"], frames[1]["loaderOrdinal"])
        self.attach(second, "RAW-OTHER-SESSION", target="RAW-OTHER-TARGET", context="RAW-OTHER-CONTEXT")
        other = self.records()[-1]
        self.assertNotEqual(other["targetOrdinal"], attached[0]["targetOrdinal"])
        self.assertNotEqual(other["contextOrdinal"], attached[0]["contextOrdinal"])

    def test_roles_are_evidence_only_and_ack_uses_connection_and_request_session(self):
        native, playwright = self.metadata.connection(), self.metadata.connection()
        self.attach(native, "RAW-NATIVE-SESSION")
        self.attach(playwright, "RAW-PW-SESSION")
        self.send(native, True, {"id": 1, "sessionId": "RAW-NATIVE-SESSION", "method": "DOM.enable", "params": {"includeWhitespace": "all"}})
        self.send(native, False, {"id": 1, "result": {}})
        self.send(native, True, {"id": 2, "sessionId": "RAW-NATIVE-SESSION", "method": "Runtime.enable"})
        self.send(playwright, True, {"id": 2, "sessionId": "RAW-PW-SESSION", "method": "Page.addScriptToEvaluateOnNewDocument", "params": {
            "source": "NEVER-OUTPUT-SCRIPT __playwright_utility_world__", "worldName": "__playwright_utility_world__", "runImmediately": True}})
        self.send(playwright, False, {"id": 2, "sessionId": "RAW-PW-SESSION", "result": {"identifier": "NEVER-OUTPUT-IDENTIFIER"}})
        self.send(native, False, {"id": 2, "sessionId": "RAW-NATIVE-SESSION", "error": {"code": -1, "message": "NEVER-OUTPUT-ERROR", "data": "NEVER-OUTPUT-DATA"}})
        self.send(native, True, {"id": 3, "sessionId": "RAW-NATIVE-SESSION", "method": "Runtime.runIfWaitingForDebugger"})
        self.send(native, False, {"id": 3, "result": {}})
        acks = [record for record in self.records() if record["kind"] == "ack"]
        registration = next(record for record in acks if record["method"] == "Page.addScriptToEvaluateOnNewDocument")
        runtime = next(record for record in acks if record["method"] == "Runtime.enable")
        self.assertEqual(registration["role"], "playwright")
        self.assertTrue(registration["identifierAck"])
        self.assertEqual(runtime["role"], "native")
        self.assertEqual(runtime["response"], "error")
        self.assertTrue(runtime["responseSessionMatches"])
        self.assertTrue(registration["responseSessionMatches"])
        self.assertEqual(runtime["responseSessionOrdinal"], runtime["sessionOrdinal"])
        self.assertNotEqual(registration["sessionOrdinal"], runtime["sessionOrdinal"])
        self.assertEqual(registration["targetOrdinal"], runtime["targetOrdinal"])
        self.assertNotEqual(registration["commandOrdinal"], runtime["commandOrdinal"])
        self.assertEqual(self.metadata.pending, {})

    def test_manual_attach_ack_binds_the_real_returned_session_to_the_requested_target(self):
        connection = self.metadata.connection()
        self.send(connection, False, {"method": "Target.targetCreated", "params": {"targetInfo": {"targetId": "RAW-TARGET", "browserContextId": "RAW-CONTEXT", "type": "page"}}})
        self.send(connection, True, {"id": 1, "method": "Target.attachToTarget", "params": {"targetId": "RAW-TARGET", "flatten": True}})
        self.attach(connection, "RAW-ATTACHED-SESSION")
        self.send(connection, False, {"method": "Page.frameNavigated", "sessionId": "RAW-ATTACHED-SESSION", "params": {"frame": {"id": "RAW-FRAME", "loaderId": "RAW-LOADER"}}})
        self.send(connection, False, {"id": 1, "result": {"sessionId": "RAW-ATTACHED-SESSION"}})
        self.send(connection, True, {"id": 2, "sessionId": "RAW-ATTACHED-SESSION", "method": "Runtime.enable"})
        self.send(connection, False, {"method": "Page.domContentEventFired", "sessionId": "RAW-ATTACHED-SESSION", "params": {}})
        records = self.records()
        attach_ack = next(record for record in records if record["kind"] == "ack")
        runtime = next(record for record in records if record.get("method") == "Runtime.enable")
        self.assertEqual(runtime["sessionOrdinal"], attach_ack["attachedSessionOrdinal"])
        self.assertEqual(runtime["targetOrdinal"], attach_ack["targetOrdinal"])
        self.assertEqual(runtime["contextOrdinal"], attach_ack["contextOrdinal"])
        self.assertEqual(next(record for record in self.records() if record["kind"] == "document")["loaderOrdinal"], 1)

    def test_detach_keeps_child_target_identity_and_late_role_is_backfilled(self):
        connection = self.metadata.connection()
        self.attach(connection, "RAW-PRIMARY")
        self.attach(connection, "RAW-DUPLICATE")
        self.send(connection, True, {"id": 1, "sessionId": "RAW-PRIMARY", "method": "Runtime.enable"})
        self.send(connection, False, {"id": 1, "sessionId": "RAW-PRIMARY", "result": {}})
        self.send(connection, True, {"id": 2, "sessionId": "RAW-PRIMARY", "method": "DOM.enable", "params": {"includeWhitespace": "all"}})
        self.send(connection, False, {"id": 2, "sessionId": "RAW-PRIMARY", "result": {}})
        self.send(connection, True, {"id": 3, "method": "Target.detachFromTarget", "params": {"sessionId": "RAW-DUPLICATE"}})
        self.send(connection, False, {"id": 3, "result": {}})
        self.metadata.finish()
        records = self.records()
        attached = [record for record in records if record["kind"] == "attached"]
        detached = [record for record in records if record.get("method") == "Target.detachFromTarget"]
        self.assertEqual(len(detached), 2)
        for record in detached:
            self.assertEqual(record["childSessionOrdinal"], attached[1]["sessionOrdinal"])
            self.assertEqual(record["targetOrdinal"], attached[0]["targetOrdinal"])
            self.assertEqual(record["role"], "native")
        runtime_ack = next(record for record in records if record["kind"] == "ack" and record.get("method") == "Runtime.enable")
        self.assertEqual(runtime_ack["role"], "native")
        self.assertEqual(attached[0]["role"], "native")

    def test_output_whitelist_filters_page_script_url_ids_and_arbitrary_errors(self):
        connection = self.metadata.connection()
        self.attach(connection, "RAW-SESSION")
        self.send(connection, True, {"id": 8, "sessionId": "RAW-SESSION", "method": "Runtime.evaluate", "params": {"expression": "NEVER-OUTPUT-PAGE"}})
        self.send(connection, False, {"id": 8, "error": {"message": "NEVER-OUTPUT-ERROR"}})
        self.send(connection, False, {"method": "Page.lifecycleEvent", "sessionId": "RAW-SESSION", "params": {"name": "NEVER-OUTPUT-LIFECYCLE", "frameId": "RAW-FRAME", "loaderId": "RAW-LOADER"}})
        self.metadata.emit("command", method="NEVER-OUTPUT-METHOD", role="NEVER-OUTPUT-ROLE", source="NEVER-OUTPUT-SOURCE", url="NEVER-OUTPUT-URL", error="NEVER-OUTPUT-ERROR")
        self.metadata.finish()
        output = self.path.read_text()
        for sentinel in ("NEVER-OUTPUT", "RAW-", "source", "expression", "https://"):
            self.assertNotIn(sentinel, output)
        lifecycle = next(record for record in self.records() if record["kind"] == "lifecycle")
        self.assertEqual(lifecycle["lifecycleName"], "other")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            relay.Metadata(self.path)

    def test_same_document_does_not_allocate_a_new_loader_and_dcl_association_is_explicit(self):
        connection = self.metadata.connection()
        self.attach(connection, "RAW-SESSION")
        self.send(connection, False, {"method": "Page.frameNavigated", "sessionId": "RAW-SESSION", "params": {"frame": {"id": "RAW-FRAME", "loaderId": "RAW-LOADER"}}})
        self.send(connection, False, {"method": "Page.navigatedWithinDocument", "sessionId": "RAW-SESSION", "params": {"frameId": "RAW-FRAME", "url": "NEVER-OUTPUT-URL"}})
        self.send(connection, False, {"method": "Page.domContentEventFired", "sessionId": "RAW-SESSION", "params": {"timestamp": 1}})
        self.assertEqual(len(self.metadata.maps["loader"]), 1)
        dcl = next(record for record in self.records() if record["kind"] == "document")
        self.assertEqual(dcl["frameSource"], "session-main-frame")
        self.assertEqual(dcl["loaderOrdinal"], 1)

    def test_caps_leave_explicit_unknowns_and_summary_within_all_output_limits(self):
        connection = self.metadata.connection()
        for index in range(relay.MAX_IDENTITIES + 20):
            self.metadata.ordinal("target", f"RAW-TARGET-{index}")
        self.assertIsNone(self.metadata.ordinal("target", "RAW-OVERFLOW"))
        for index in range(relay.MAX_PENDING + 20):
            self.send(connection, True, {"id": index, "method": "Runtime.enable"})
        for _ in range(relay.MAX_RECORDS + 20):
            self.metadata.emit("connection", connectionOrdinal=connection)
        self.metadata.finish()
        summary = self.records()[-1]
        self.assertTrue(summary["targetOverflow"])
        self.assertTrue(summary["pendingOverflow"])
        self.assertTrue(summary["recordsCapped"] or summary["bytesCapped"])
        self.assertFalse(summary["metadataComplete"])
        self.assertEqual(len(self.metadata.maps["target"]), relay.MAX_IDENTITIES)
        self.assertEqual(len(self.metadata.pending), relay.MAX_PENDING)
        self.assertLessEqual(len(self.metadata.lines), relay.MAX_RECORDS)
        self.assertLessEqual(self.path.stat().st_size, relay.MAX_BYTES)
        self.assertTrue(all(len(line) <= relay.MAX_LINE_BYTES for line in self.metadata.lines))

    def test_forwarding_keeps_original_wire_objects_and_adds_no_messages(self):
        connection = self.metadata.connection()
        wires = [' {"id":1,"method":"Runtime.enable"} ', b'{"id":2,"method":"Runtime.evaluate","params":{"expression":"NEVER-OUTPUT"}}']

        class Source:
            async def __aiter__(self):
                for wire in wires:
                    yield wire

        class Destination:
            def __init__(self):
                self.sent = []

            async def send(self, wire):
                self.sent.append(wire)

        destination = Destination()
        asyncio.run(relay.forward(Source(), destination, True, self.metadata, connection))
        self.assertEqual(len(destination.sent), len(wires))
        for actual, original in zip(destination.sent, wires):
            self.assertIs(actual, original)

    def known_connection(self):
        connection = self.metadata.connection()
        self.metadata.role(connection, "native", "dom-whitespace-all")
        return connection

    def assert_incomplete(self, flag):
        self.metadata.finish()
        summary = self.records()[-1]
        self.assertTrue(summary[flag])
        self.assertFalse(summary["metadataComplete"])

    def test_wrong_session_attach_ack_cannot_bind_returned_child(self):
        connection = self.known_connection()
        self.send(connection, True, {"id": 1, "sessionId": "PARENT", "method": "Target.attachToTarget", "params": {"targetId": "CHILD"}})
        self.send(connection, False, {"id": 1, "sessionId": "WRONG", "result": {"sessionId": "RETURNED"}})
        self.assertNotIn((connection, "RETURNED"), self.metadata.bindings)
        ack = self.records()[-1]
        self.assertFalse(ack["responseSessionMatches"])
        self.assertIsNone(ack["attachedSessionOrdinal"])
        self.assert_incomplete("correlationLost")

    def test_wrong_session_frame_ack_cannot_replace_existing_frame(self):
        connection = self.known_connection()
        self.attach(connection, "PAGE")
        self.send(connection, False, {"method": "Page.frameNavigated", "sessionId": "PAGE", "params": {"frame": {"id": "ORIGINAL", "loaderId": "LOADER"}}})
        before = dict(self.metadata.bindings[(connection, "PAGE")])
        self.send(connection, True, {"id": 1, "sessionId": "PAGE", "method": "Page.getFrameTree"})
        self.send(connection, False, {"id": 1, "sessionId": "WRONG", "result": {"frameTree": {"frame": {"id": "POISON", "loaderId": "POISON"}}}})
        self.assertEqual(self.metadata.bindings[(connection, "PAGE")], before)
        self.assertNotIn("POISON", self.metadata.maps["frame"])
        self.assert_incomplete("correlationLost")

    def test_root_ack_matches_only_absent_session_not_malformed_or_foreign(self):
        connection = self.known_connection()
        self.send(connection, True, {"id": 1, "method": "Target.attachToTarget", "params": {"targetId": "GOOD"}})
        self.send(connection, False, {"id": 1, "result": {"sessionId": "GOOD-SESSION"}})
        self.assertTrue(self.records()[-1]["responseSessionMatches"])
        self.assertIn((connection, "GOOD-SESSION"), self.metadata.bindings)
        for request, response in [(2, {"sessionId": None}), (3, {"sessionId": "FOREIGN"})]:
            self.send(connection, True, {"id": request, "method": "Target.attachToTarget", "params": {"targetId": "BAD"}})
            self.send(connection, False, {"id": request, **response, "result": {"sessionId": "BAD-SESSION"}})
        self.assertNotIn((connection, "BAD-SESSION"), self.metadata.bindings)
        self.assert_incomplete("correlationLost")

    def test_same_session_text_is_separate_per_connection_but_target_can_join(self):
        first, second = self.metadata.connection(), self.metadata.connection()
        self.attach(first, "SAME", "TARGET-A")
        self.attach(second, "SAME", "TARGET-B")
        a, b = [r for r in self.records() if r["kind"] == "attached"]
        self.assertNotEqual(a["sessionOrdinal"], b["sessionOrdinal"])
        self.assertNotEqual(a["targetOrdinal"], b["targetOrdinal"])
        self.assertEqual(self.metadata.bindings[(first, "SAME")]["targetOrdinal"], a["targetOrdinal"])
        self.assertEqual(self.metadata.bindings[(second, "SAME")]["targetOrdinal"], b["targetOrdinal"])

    def test_transport_error_prevents_complete_without_pending_or_unknown_role(self):
        connection = self.known_connection()
        self.metadata.emit("transport", connectionOrdinal=connection, transportState="error")
        self.assert_incomplete("transportError")

    def test_invalid_json_and_nonobject_cannot_report_complete(self):
        connection = self.known_connection()
        self.metadata.observe(connection, False, "invalid-json")
        self.metadata.observe(connection, False, "[]")
        self.assert_incomplete("invalidJson")

    def test_missing_session_ack_does_not_complete_script_correlation(self):
        connection = self.known_connection()
        self.attach(connection, "PAGE")
        self.send(connection, True, {"id": 1, "sessionId": "PAGE", "method": "Page.addScriptToEvaluateOnNewDocument"})
        self.send(connection, False, {"id": 1, "result": {"identifier": "SCRIPT"}})
        self.assertFalse(self.records()[-1]["responseSessionMatches"])
        self.assertIsNone(self.records()[-1]["identifierAck"])
        self.assert_incomplete("correlationLost")

    def test_malformed_result_does_not_mutate_mapping_or_report_complete(self):
        connection = self.known_connection()
        self.send(connection, True, {"id": 1, "method": "Target.attachToTarget", "params": {"targetId": "TARGET"}})
        self.send(connection, False, {"id": 1, "result": {"sessionId": "CHILD"}, "error": {"message": "PRIVATE"}})
        self.assertNotIn((connection, "CHILD"), self.metadata.bindings)
        self.assert_incomplete("correlationLost")

    def test_complete_positive_requires_valid_matched_ack_and_no_loss(self):
        connection = self.known_connection()
        self.attach(connection, "PAGE")
        self.send(connection, True, {"id": 1, "sessionId": "PAGE", "method": "Runtime.enable"})
        self.send(connection, False, {"id": 1, "sessionId": "PAGE", "result": {}})
        self.metadata.finish()
        self.assertTrue(self.records()[-1]["metadataComplete"])


if __name__ == "__main__":
    unittest.main()
