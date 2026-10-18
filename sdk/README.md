# QuickGUI C host SDK v2

Scripts define `void qg_process(void)` and can include `quickgui.h`. Host calls
read JSON/string/numeric input, emit JSON/string/numeric output, read/write numeric
variables, log UTF-8 messages, and persist per-script numeric state. Existing
numeric calls retain their C ABI. Missing state starts
at zero; missing variables are errors. Keys and messages are at most 4096 bytes.
Non-finite numbers are errors. Script writes are committed together only after
the worker completes successfully and the engine validates every target.

`qg_input_json()` returns serialized JSON for any input type. `qg_input_string()`
requires a JSON string without embedded NUL. These read-only pointers stay valid
for the current `qg_process` invocation; do not free or retain them afterward.
`qg_emit_json` validates and copies JSON, while `qg_emit_string` copies UTF-8 text.
JSON/string values are limited to 1 MiB and the complete IPC message to 2 MiB.
Use JSON escaping to represent embedded NUL. Using the numeric accessor on a
non-numeric input, using the wrong string accessor, or emitting invalid JSON
fails the invocation; no coerced numeric result is committed. Variables and
script state remain numeric maps in this SDK version.

The ABI is a worker-local C interface. Across processes the engine exchanges
one camelCase JSON `ScriptRequest` and `ScriptResponse` per line. Failure is
`{"error":"description"}`. A crash, deadline or cancellation never becomes a
fabricated script result. This implementation starts a disposable worker for
each invocation and sends serialized state, so state is independent of native
pointers and JIT memory. This is fault isolation for trusted C source, not an
OS security sandbox. File/network access is not a supported host API capability.

`ScriptHost::validate` starts the same isolated worker with `--check`: JIT mode
compiles, links and resolves `qg_process` but never calls it; AOT mode verifies
the source hash without invoking compiled code. The normal deadline and
cancellation controls apply. Validate changed scripts before installing a
candidate project so a compile/link error can preserve the last valid preview.
Before sending source for validation, the host probes the selected executable
with empty stdin and requires `compileCheck: true` in `--capabilities`. Older
ABI v2 workers are rejected with a rebuild instruction, since they may not
recognize `--check`. The capability probe and compilation share one deadline.
The runner rejects unknown command-line arguments instead of ignoring them.

## Development JIT

Run `node scripts/setup-tcc.mjs`, then `cargo run -p quickgui-c-runner -- --self-test`.
The build script requires a C compiler, make, sh and tar (Windows: MSYS2 tools).
Use `QG_LIBTCC` to select the shared library and `QG_TCC_HOME` for the TinyCC runtime
directory. The pinned revision uses the one-argument `tcc_relocate` ABI; arbitrary
system libtcc versions are not supported. `.toolchain/tinycc-build.json` records
the revision, archive SHA256 and target platform.

The script builds upstream `ONE_SOURCE=yes`. This keeps TinyCC internal symbols
static: its Darwin flat-namespace build otherwise lets symbols such as
`parse_flags` collide with Apple framework symbols loaded by native dependencies.
No upstream source patch is applied for this build configuration.

macOS JIT under signing/hardened runtime is a release gate. A development
self-test is insufficient. This build does not claim to adapt upstream JIT
allocation to hardened runtime; verify/implement that separately before shipping
a signed designer with C preview. AOT runtime does not require JIT compilation.

## Independent AOT build

`node scripts/build-aot.mjs path/to/project.json path/to/output-workers` compiles
each distinct C source with CMake/Clang, links it to this same Rust worker runner,
and emits an `aot-manifest.json` mapping source SHA256 to executable filename.
`ScriptHost` selects this manifest next to its configured executable when present;
modified source requires a rebuild. The generated workers validate source hashes
and never silently execute a different script. A single `.c` file is accepted too.

The engine, renderer, C SDK, build scripts and project documents belong in the
independent source export. Node, Cargo, CMake and Clang are build requirements;
the distributed runtime needs none of them. Sign/package worker executables as
nested application code for the target platform. Rebuild on each target platform.

## Graph and migration semantics

The starter engine accepts DAGs with event entry points. Each incoming activation
executes a node, in stable topological order; joins process every active incoming
value. Runs are limited to 10000 activations. Conditions route via `true`/`false`
source handles. Repetition uses new external events; graph cycles are rejected.
`emit` notifies the host through `set_event_observer` with event name, payload,
time, flow/node IDs, and also records a log. It does not recursively dispatch
another flow. `set_observer` streams snapshots after runtime changes without
requiring the host to poll a locked engine. Per-flow deadlines
are 60 seconds; script deadlines are capped at 60 seconds. These limits and join
semantics are explicit starter-engine contracts.

`run_event` seeds only the named event entry, for independent startup/timer event
sources; `run_flow` seeds every event entry for an explicit whole-flow run.
The `connection` node uses `config.connectionId` to execute one configured bounded
connection operation and forwards the actual result to downstream nodes.

Project replacement validates the complete new project before replacing it.
Within the same project ID, variable ID/type matches preserve current values,
including renames, and script IDs preserve numeric state. Removing a script
removes its state. Script state schema migrations are not yet implemented.

Snapshot `values` keys are stable variable IDs. Engine reads/writes accept IDs or
names (IDs take precedence); renaming a variable preserves its value by ID.
Snapshots also carry `projectId`, document `revision`, and a monotonically
increasing `sequence` for the current project session. Consumers reject snapshots
from another project or older revision/sequence to avoid command-response and
event-delivery races. Sequence numbers are not part of persistence deduplication.

## Explicit connection tests

`test_connection(Connection)` opens a short-lived connection only when invoked.
HTTP/WS/MQTT use `config.url`; TCP accepts `tcp://host:port` or `address` + `port`.
Serial uses `address` (device path/COM name), `baudRate` (default 115200), 8N1,
no flow control. Common options: `timeoutMs` (100..15000, default 3000), `message`,
`expectReply` (defaults true when a message exists), and `listen` (receive only).
TCP/serial `framing` is `raw`, `line`, or `length16` (big-endian byte count).
Payloads/responses are limited to 65535 bytes. `received` is diagnostic UTF-8
text with replacement for nontext bytes; use protocol-specific binary tooling
for lossless binary inspection.

HTTP also accepts `method` and a string-valued `headers` object. WS performs a
real handshake and optional text-frame round trip. MQTT uses optional username/
password, `topic`, `payload` and `action=connect|publish|subscribe`; default action
is publish when payload exists, otherwise subscribe when a topic exists, otherwise
connect. Publish waits for QoS1 PUBACK; subscribe waits for one actual message.
TLS certificate verification remains enabled. Errors and deadlines are returned
to the caller. These are explicit diagnostics, not continuously running drivers.

AOT `--target` currently accepts only the installed Rust host target; build on
native Windows x64/macOS Intel/macOS ARM64 CI workers for the respective targets.

## Runtime persistence, history and alarms

`HistoryStore` is a Send, non-Clone SQLite connection intended for a dedicated
background recorder. The host owns its bounded queue and flush barriers; engine
observers must enqueue snapshots instead of performing synchronous disk writes.
WAL transactions commit changed persistent values, sampled numerical changes,
deduplicated logs and alarm transitions together. Timestamp-only or canvas
activity changes skip write transactions; invalid snapshots roll back all writes.

Only variables declaring `persistent: true` restore across application restarts.
The project ID, variable ID and declared value type must match; renaming a
variable preserves its value. Only values with good quality replace persistent
values. `Engine::restore_persistent_values` validates the entire restore set and
can restore read-only variables before observers and event sources are attached.

Default history sampling is at most 4 Hz per variable and only stores numerical
value/quality changes. Defaults retain at most 10000 samples per variable,
100000 samples overall, 10000 logs and 2000 closed alarms, with a 30-day age limit.
Cleanup happens when processing snapshots; unchanged snapshots perform age
maintenance at most once per minute (or the shorter configured retention period).
Samples inside the interval may be coalesced; persistence retains the latest
processed value. This is sampled HMI history, not a lossless telemetry recorder.

Numeric `alarm.min` / `alarm.max` trigger on strict under/over thresholds. An
incident stays active until good data recovers, the rule changes, or its variable
is removed. Bad/stale quality cannot falsely clear an active incident.
Acknowledgement records a timestamp and does not clear an active incident.
Active incidents survive retention cleanup. Alarm queries place active incidents
first; history queries return the latest bounded sample set in ascending order.
