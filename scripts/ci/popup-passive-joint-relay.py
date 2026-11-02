"""Passive loopback CDP forwarding with bounded, shared identity metadata.

Usage: python3 popup-passive-joint-relay.py UPSTREAM_WS NEW_EVIDENCE_JSONL
Any stdin input/EOF or SIGTERM/SIGINT closes the relay and flushes evidence.
No command is added, rewritten, delayed, or withheld for a diagnostic decision.
"""
import asyncio
import json
import logging
import os
import signal
import sys
import time
from urllib.parse import urlsplit

MAX_RECORDS = 2_000
MAX_BYTES = 256 * 1024
MAX_LINE_BYTES = 1_024
MAX_IDENTITIES = 256
MAX_CONNECTIONS = 16
MAX_PENDING = 256
METHODS = frozenset({
    "DOM.enable", "Runtime.enable", "Runtime.runIfWaitingForDebugger",
    "Page.addScriptToEvaluateOnNewDocument", "Page.getFrameTree", "Target.attachToTarget", "Target.detachFromTarget",
})
TARGET_KINDS = frozenset({"page", "iframe", "browser", "worker", "service_worker", "shared_worker", "background_page", "webview", "other"})
LIFECYCLES = frozenset({"init", "DOMContentLoaded", "load", "networkAlmostIdle", "networkIdle", "firstPaint", "firstContentfulPaint", "firstMeaningfulPaintCandidate", "firstMeaningfulPaint", "firstImagePaint", "other"})
KINDS = frozenset({"connection", "role", "command", "ack", "attached", "target", "detached", "frame", "lifecycle", "context", "context-cleared", "document", "transport", "summary"})
ORDINALS = frozenset({"connectionOrdinal", "sessionOrdinal", "childSessionOrdinal", "responseSessionOrdinal", "attachedSessionOrdinal", "parentSessionOrdinal", "targetOrdinal", "openerTargetOrdinal", "contextOrdinal", "frameOrdinal", "parentFrameOrdinal", "loaderOrdinal", "uniqueContextOrdinal", "commandOrdinal", "scriptOrdinal"})
COUNTS = frozenset({"durationUs", "connections", "messages", "ignoredResponses", "pendingCount", "discardedRecords", "recordsWritten", "bytesBeforeSummary", "unknownRoles"})
BOOLS = frozenset({"runImmediately", "identifierAck", "responseSessionMatches", "waitingForDebugger", "openerPresent", "contextPresent", "isDefault", "mainFrame", "metadataComplete", "recordsCapped", "bytesCapped", "lineCapped", "pendingOverflow", "bindingOverflow", "connectionOverflow", "targetOverflow", "contextOverflow", "frameOverflow", "loaderOverflow", "sessionOverflow", "uniqueOverflow", "transportError", "invalidJson", "correlationLost"})
ENUMS = {
    "role": frozenset({"unknown", "native", "playwright", "mixed"}),
    "signal": frozenset({"dom-whitespace-all", "pw-utility-world"}),
    "method": METHODS,
    "response": frozenset({"ok", "error"}),
    "targetKind": TARGET_KINDS,
    "lifecycleName": LIFECYCLES,
    "targetEvent": frozenset({"created", "changed", "destroyed"}),
    "frameEvent": frozenset({"navigated", "same-document", "tree"}),
    "frameSource": frozenset({"wire", "session-main-frame", "unknown"}),
    "contextKind": frozenset({"default", "isolated", "other"}),
    "documentEvent": frozenset({"DOMContentLoaded", "load"}),
    "transportState": frozenset({"opened", "closed", "error", "invalid-json"}),
}


def obj(value):
    return value if isinstance(value, dict) else {}


def boolean(value):
    return value if isinstance(value, bool) else None


def raw_id(value):
    return value if isinstance(value, str) and 0 < len(value) <= 512 else None


def closed(value, allowed):
    return value if isinstance(value, str) and value in allowed else "other"


class Metadata:
    def __init__(self, evidence):
        self.fd = os.open(evidence, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.fchmod(self.fd, 0o600)
        self.started = time.monotonic_ns()
        self.lines = []
        self.bytes = 0
        self.discarded = 0
        self.flags = {key: False for key in BOOLS if key.endswith("Overflow") or key.endswith("Capped") or key in {"transportError", "invalidJson", "correlationLost"}}
        self.maps = {key: {} for key in ("target", "context", "frame", "loader", "session", "unique")}
        self.bindings = {}
        self.target_contexts = {}
        self.roles = {}
        self.pending = {}
        self.connections = 0
        self.messages = 0
        self.ignored_responses = 0
        self.commands = 0
        self.scripts = 0
        self.finished = False

    def now(self):
        return (time.monotonic_ns() - self.started) // 1_000

    def ordinal(self, domain, value):
        value = raw_id(value)
        if value is None:
            return None
        mapping = self.maps[domain]
        if value in mapping:
            return mapping[value]
        if len(mapping) >= MAX_IDENTITIES:
            self.flags[domain + "Overflow"] = True
            return None
        mapping[value] = len(mapping) + 1
        return mapping[value]

    def session_ordinal(self, connection, session):
        """Session text is meaningful only on its owning transport."""
        session = raw_id(session)
        if session is None:
            return None
        mapping = self.maps["session"]
        key = (connection, session)
        if key not in mapping:
            if len(mapping) >= MAX_IDENTITIES:
                self.flags["sessionOverflow"] = True
                return None
            mapping[key] = len(mapping) + 1
        return mapping[key]

    def emit(self, kind, **fields):
        """Only closed enums, nullable ordinals/bools and counts can reach output."""
        if self.finished or kind not in KINDS:
            return
        if kind == "transport":
            if fields.get("transportState") == "error":
                self.flags["transportError"] = True
            elif fields.get("transportState") == "invalid-json":
                self.flags["invalidJson"] = True
        record = {"kind": kind, "monotonicUs": self.now()}
        for key, value in fields.items():
            if key in ORDINALS and (value is None or (type(value) is int and value > 0)):
                record[key] = value
            elif key in COUNTS and type(value) is int and value >= 0:
                record[key] = value
            elif key in BOOLS and (value is None or type(value) is bool):
                record[key] = value
            elif key in ENUMS and isinstance(value, str) and value in ENUMS[key]:
                record[key] = value
        line = json.dumps(record, separators=(",", ":"), ensure_ascii=True).encode() + b"\n"
        if kind != "summary":
            if len(line) > MAX_LINE_BYTES:
                self.flags["lineCapped"] = True
            elif len(self.lines) >= MAX_RECORDS - 1:
                self.flags["recordsCapped"] = True
            elif self.bytes + len(line) > MAX_BYTES - MAX_LINE_BYTES:
                self.flags["bytesCapped"] = True
            else:
                self.lines.append(line)
                self.bytes += len(line)
                return
            self.discarded += 1
        elif len(line) <= MAX_LINE_BYTES and self.bytes + len(line) <= MAX_BYTES:
            self.lines.append(line)
            self.bytes += len(line)

    def connection(self):
        self.connections += 1
        if self.connections > MAX_CONNECTIONS:
            self.flags["connectionOverflow"] = True
            return None
        self.roles[self.connections] = "unknown"
        self.emit("connection", connectionOrdinal=self.connections, role="unknown")
        return self.connections

    def role(self, connection, role, evidence):
        previous = self.roles[connection]
        current = role if previous == "unknown" else previous if previous == role else "mixed"
        if current != previous:
            self.roles[connection] = current
            self.emit("role", connectionOrdinal=connection, role=current, signal=evidence)

    def target(self, info):
        target = self.ordinal("target", info.get("targetId"))
        context = self.ordinal("context", info.get("browserContextId"))
        if target is not None:
            if context is not None:
                self.target_contexts[target] = context
            else:
                context = self.target_contexts.get(target)
        return target, context

    def bind(self, connection, session, target, context):
        session = raw_id(session)
        if session is None:
            return
        key = (connection, session)
        if key not in self.bindings and len(self.bindings) >= MAX_IDENTITIES:
            self.flags["bindingOverflow"] = True
            return
        self.session_ordinal(connection, session)
        previous = self.bindings.get(key)
        if previous is not None and previous["targetOrdinal"] == target and previous["contextOrdinal"] == context:
            return
        self.bindings[key] = {"targetOrdinal": target, "contextOrdinal": context, "frameOrdinal": None, "loaderOrdinal": None}

    def base(self, connection, session):
        binding = self.bindings.get((connection, raw_id(session)), {})
        target = binding.get("targetOrdinal")
        context = binding.get("contextOrdinal")
        return {"connectionOrdinal": connection, "role": self.roles[connection], "sessionOrdinal": self.session_ordinal(connection, session),
                "targetOrdinal": target, "contextOrdinal": context if context is not None else self.target_contexts.get(target)}

    def frame(self, connection, session, frame):
        frame_ordinal = self.ordinal("frame", frame.get("id"))
        loader_ordinal = self.ordinal("loader", frame.get("loaderId"))
        main = raw_id(frame.get("parentId")) is None if frame_ordinal is not None else None
        binding = self.bindings.get((connection, raw_id(session)))
        if main and binding is not None:
            binding["frameOrdinal"] = frame_ordinal
            binding["loaderOrdinal"] = loader_ordinal
        return {"frameOrdinal": frame_ordinal, "loaderOrdinal": loader_ordinal,
                "parentFrameOrdinal": self.ordinal("frame", frame.get("parentId")), "mainFrame": main, "frameSource": "wire"}

    def observe(self, connection, outbound, wire):
        if connection is None or self.finished:
            return
        self.messages += 1
        try:
            message = json.loads(wire)
        except (ValueError, UnicodeError, TypeError):
            self.emit("transport", connectionOrdinal=connection, transportState="invalid-json")
            return
        if not isinstance(message, dict):
            self.emit("transport", connectionOrdinal=connection, transportState="invalid-json")
            return
        if outbound:
            self.request(connection, message)
        elif "id" in message:
            self.response(connection, message)
        else:
            self.event(connection, message)

    def request(self, connection, message):
        method, params = message.get("method"), obj(message.get("params"))
        if method == "DOM.enable" and params.get("includeWhitespace") == "all":
            self.role(connection, "native", "dom-whitespace-all")
        if method == "Page.addScriptToEvaluateOnNewDocument":
            world, source = params.get("worldName"), params.get("source")
            if ((isinstance(world, str) and world.startswith("__playwright_utility_world__")) or
                    (isinstance(source, str) and "__playwright_utility_world__" in source)):
                self.role(connection, "playwright", "pw-utility-world")
        if not isinstance(method, str) or method not in METHODS:
            return
        self.commands += 1
        script = None
        if method == "Page.addScriptToEvaluateOnNewDocument":
            self.scripts += 1
            script = self.scripts
        session = raw_id(message.get("sessionId"))
        command = {"method": method, "session": session, "commandOrdinal": self.commands,
                   "scriptOrdinal": script, "sentUs": self.now(), "targetOrdinal": None,
                   "sessionValid": "sessionId" not in message or session is not None}
        if method == "Target.attachToTarget":
            command["targetOrdinal"] = self.ordinal("target", params.get("targetId"))
        elif method == "Target.detachFromTarget":
            child = raw_id(params.get("sessionId"))
            binding = self.bindings.get((connection, child), {})
            command["childSessionOrdinal"] = self.session_ordinal(connection, child)
            command["targetOrdinal"] = binding.get("targetOrdinal")
            command["contextOrdinal"] = binding.get("contextOrdinal")
        request_id = message.get("id")
        if type(request_id) is int and 0 <= request_id < 2 ** 53:
            key = (connection, request_id)
            if key in self.pending:
                self.pending.pop(key)
                self.flags["pendingOverflow"] = True
            elif len(self.pending) < MAX_PENDING:
                self.pending[key] = command
            else:
                self.flags["pendingOverflow"] = True
        else:
            self.flags["correlationLost"] = True
        if "sessionId" in message and session is None:
            self.flags["correlationLost"] = True
        fields = self.base(connection, session)
        if method == "Target.attachToTarget":
            fields["targetOrdinal"] = command["targetOrdinal"]
            fields["contextOrdinal"] = self.target_contexts.get(command["targetOrdinal"])
        elif method == "Target.detachFromTarget":
            fields["childSessionOrdinal"] = command["childSessionOrdinal"]
            fields["targetOrdinal"] = command["targetOrdinal"]
            fields["contextOrdinal"] = command["contextOrdinal"]
        self.emit("command", **fields, method=method, commandOrdinal=self.commands,
                  scriptOrdinal=script, runImmediately=boolean(params.get("runImmediately")))

    def response(self, connection, message):
        request_id = message.get("id")
        command = self.pending.pop((connection, request_id), None) if type(request_id) is int else None
        if command is None:
            self.ignored_responses += 1
            return
        method, session, result = command["method"], command["session"], obj(message.get("result"))
        error = "error" in message
        response_session = raw_id(message.get("sessionId"))
        session_valid = "sessionId" not in message or response_session is not None
        session_matches = session_valid and response_session == session
        envelope_valid = (isinstance(message.get("error"), dict) if error else isinstance(message.get("result"), dict)) and not ("error" in message and "result" in message)
        accepted = command["sessionValid"] and session_matches and envelope_valid
        if not accepted:
            # A matched numeric ID alone must never create target/frame authority.
            self.flags["correlationLost"] = True
        if accepted and not error and method == "Target.attachToTarget":
            if raw_id(result.get("sessionId")) is None or command["targetOrdinal"] is None:
                self.flags["correlationLost"] = True
            else:
                self.bind(connection, result.get("sessionId"), command["targetOrdinal"], self.target_contexts.get(command["targetOrdinal"]))
        fields = self.base(connection, session)
        fields["responseSessionOrdinal"] = self.session_ordinal(connection, response_session)
        fields["responseSessionMatches"] = session_matches
        if method == "Target.attachToTarget":
            fields["attachedSessionOrdinal"] = self.session_ordinal(connection, result.get("sessionId")) if accepted and not error else None
            fields["targetOrdinal"] = command["targetOrdinal"]
            fields["contextOrdinal"] = self.target_contexts.get(command["targetOrdinal"])
        elif method == "Target.detachFromTarget":
            fields["childSessionOrdinal"] = command["childSessionOrdinal"]
            fields["targetOrdinal"] = command["targetOrdinal"]
            fields["contextOrdinal"] = command["contextOrdinal"]
        if accepted and not error and method == "Page.getFrameTree":
            frame = obj(obj(result.get("frameTree")).get("frame"))
            if raw_id(frame.get("id")) is None:
                self.flags["correlationLost"] = True
            else:
                fields.update(self.frame(connection, session, frame))
        self.emit("ack", **fields, method=method, commandOrdinal=command["commandOrdinal"], scriptOrdinal=command["scriptOrdinal"],
                  response="error" if error else "ok", durationUs=max(0, self.now() - command["sentUs"]),
                  identifierAck=bool(raw_id(result.get("identifier"))) if accepted and not error and method == "Page.addScriptToEvaluateOnNewDocument" else None)

    def event(self, connection, message):
        method, params, session = message.get("method"), obj(message.get("params")), message.get("sessionId")
        if method in ("Target.targetCreated", "Target.targetInfoChanged", "Target.attachedToTarget"):
            info = obj(params.get("targetInfo"))
            target, context = self.target(info)
            if method == "Target.attachedToTarget":
                child = params.get("sessionId")
                self.bind(connection, child, target, context)
                fields = self.base(connection, child)
                fields["parentSessionOrdinal"] = self.session_ordinal(connection, session)
                self.emit("attached", **fields, targetKind=closed(info.get("type"), TARGET_KINDS),
                          waitingForDebugger=boolean(params.get("waitingForDebugger")), openerPresent=raw_id(info.get("openerId")) is not None,
                          openerTargetOrdinal=self.ordinal("target", info.get("openerId")), contextPresent=raw_id(info.get("browserContextId")) is not None)
            else:
                self.emit("target", connectionOrdinal=connection, role=self.roles[connection], targetOrdinal=target, contextOrdinal=context,
                          targetEvent="created" if method == "Target.targetCreated" else "changed", targetKind=closed(info.get("type"), TARGET_KINDS),
                          openerPresent=raw_id(info.get("openerId")) is not None, openerTargetOrdinal=self.ordinal("target", info.get("openerId")),
                          contextPresent=raw_id(info.get("browserContextId")) is not None)
        elif method == "Target.targetDestroyed":
            self.emit("target", connectionOrdinal=connection, targetOrdinal=self.ordinal("target", params.get("targetId")), targetEvent="destroyed")
        elif method == "Target.detachedFromTarget":
            self.emit("detached", **self.base(connection, params.get("sessionId")))
        elif method == "Page.frameNavigated":
            self.emit("frame", **self.base(connection, session), **self.frame(connection, session, obj(params.get("frame"))), frameEvent="navigated")
        elif method == "Page.navigatedWithinDocument":
            frame = self.ordinal("frame", params.get("frameId"))
            binding = self.bindings.get((connection, raw_id(session)), {})
            self.emit("frame", **self.base(connection, session), frameOrdinal=frame, frameEvent="same-document", frameSource="wire",
                      loaderOrdinal=binding.get("loaderOrdinal") if binding.get("frameOrdinal") == frame else None)
        elif method == "Page.lifecycleEvent":
            self.emit("lifecycle", **self.base(connection, session), frameOrdinal=self.ordinal("frame", params.get("frameId")),
                      loaderOrdinal=self.ordinal("loader", params.get("loaderId")), lifecycleName=closed(params.get("name"), LIFECYCLES), frameSource="wire")
        elif method in ("Page.domContentEventFired", "Page.loadEventFired"):
            binding = self.bindings.get((connection, raw_id(session)), {})
            self.emit("document", **self.base(connection, session), documentEvent="DOMContentLoaded" if method == "Page.domContentEventFired" else "load",
                      frameOrdinal=binding.get("frameOrdinal"), loaderOrdinal=binding.get("loaderOrdinal"), frameSource="session-main-frame" if binding else "unknown")
        elif method == "Runtime.executionContextCreated":
            context = obj(params.get("context"))
            auxiliary = obj(context.get("auxData"))
            default = boolean(auxiliary.get("isDefault"))
            self.emit("context", **self.base(connection, session), isDefault=default,
                      frameOrdinal=self.ordinal("frame", auxiliary.get("frameId")), frameSource="wire",
                      contextKind=closed(auxiliary.get("type"), frozenset({"default", "isolated", "other"})),
                      uniqueContextOrdinal=self.ordinal("unique", context.get("uniqueId")) if default is True else None)
        elif method == "Runtime.executionContextsCleared":
            self.emit("context-cleared", **self.base(connection, session))

    def finish(self):
        if self.finished:
            return
        # Roles are evidence-based, possibly learned after early session events.
        # Re-encode only our own already-whitelisted records, keeping timestamps.
        previous = self.lines
        self.lines, self.bytes = [], 0
        for line in previous:
            record = json.loads(line)
            connection = record.get("connectionOrdinal")
            if connection in self.roles:
                record["role"] = self.roles[connection]
            line = json.dumps(record, separators=(",", ":"), ensure_ascii=True).encode() + b"\n"
            if len(line) > MAX_LINE_BYTES:
                self.flags["lineCapped"] = True
            elif self.bytes + len(line) > MAX_BYTES - MAX_LINE_BYTES:
                self.flags["bytesCapped"] = True
            else:
                self.lines.append(line)
                self.bytes += len(line)
                continue
            self.discarded += 1
        unknown_roles = sum(role in ("unknown", "mixed") for role in self.roles.values())
        self.emit("summary", metadataComplete=self.connections > 0 and not any(self.flags.values()) and not self.pending and not unknown_roles,
                  connections=self.connections, messages=self.messages, ignoredResponses=self.ignored_responses,
                  pendingCount=len(self.pending), discardedRecords=self.discarded, recordsWritten=len(self.lines) + 1,
                  bytesBeforeSummary=self.bytes, unknownRoles=unknown_roles, **self.flags)
        self.finished = True
        with os.fdopen(self.fd, "wb") as evidence:
            evidence.writelines(self.lines)


async def forward(source, destination, outbound, metadata, connection):
    async for wire in source:
        metadata.observe(connection, outbound, wire)
        await destination.send(wire)


async def main():
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve

    if len(sys.argv) != 3:
        raise ValueError("configuration")
    endpoint, evidence = sys.argv[1:]
    parsed = urlsplit(endpoint)
    if parsed.scheme not in ("ws", "wss") or parsed.hostname not in ("127.0.0.1", "::1", "localhost") or parsed.username is not None:
        raise ValueError("configuration")
    metadata = Metadata(evidence)
    logger = logging.getLogger("popup-passive-joint-relay")
    logger.addHandler(logging.NullHandler())
    logger.propagate = False
    logger.disabled = True

    async def relay(frontend):
        connection = metadata.connection()
        try:
            async with connect(endpoint, max_size=16 * 1024 * 1024, logger=logger) as backend:
                metadata.emit("transport", connectionOrdinal=connection, transportState="opened")

                tasks = [asyncio.create_task(forward(frontend, backend, True, metadata, connection)), asyncio.create_task(forward(backend, frontend, False, metadata, connection))]
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    results = await asyncio.gather(*tasks, return_exceptions=True)
                    if any(isinstance(result, Exception) for result in results):
                        metadata.emit("transport", connectionOrdinal=connection, transportState="error")
                metadata.emit("transport", connectionOrdinal=connection, transportState="closed")
        except Exception:
            metadata.emit("transport", connectionOrdinal=connection, transportState="error")

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    try:
        loop.add_reader(sys.stdin.fileno(), stop.set)
        for signum in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(signum, stop.set)
        async with serve(relay, "127.0.0.1", 0, max_size=16 * 1024 * 1024, logger=logger) as server:
            port = server.sockets[0].getsockname()[1]
            print(json.dumps({"endpoint": f"ws://127.0.0.1:{port}/devtools/browser/passive-joint"}), flush=True)
            await stop.wait()
    finally:
        loop.remove_reader(sys.stdin.fileno())
        metadata.finish()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        sys.stderr.write("passive relay failed\n")
        sys.exit(1)
