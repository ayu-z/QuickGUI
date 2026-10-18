# Serial v4 implementation contract

This is the shared contract for the serial assistant implementation. Production uses real native serial ports, without a simulator or Web Serial. Existing v1–v3 node semantics remain unchanged; new capabilities require explicit schema v4 migration. Ordinary empty projects remain v3.

## Values and data nodes

```ts
type ValueRef =
  | { source: 'literal'; value: Json }
  | { source: 'input'; path?: JsonPath }
  | { source: 'variable'; variable: string; path?: JsonPath };
```

New variable references use stable IDs. Paths use the existing typed JSON path rules; missing is an error, not null. Configs are JSON objects, validated before use.

- `kind: 'map'`: `operation: 'value' | 'object' | 'array'`.
  - value: `value: ValueRef` returns the resolved value.
  - object: `fields: Record<string, ValueRef>` returns an object.
  - array: `items: ValueRef` must resolve to an array; `fields` builds each output object, with input paths relative to the current item.
- `kind: 'append'`: `variable: string`, optional `path: JsonPath`, `item: ValueRef`, `maxItems` (default 500), `maxBytes` (default 524288), `order: 'latestFirst' | 'oldestFirst'` (default oldestFirst), optional `droppedPath: JsonPath` within the same JSON variable. Append and increment of droppedPath are one atomic write. Output: `{items, droppedItems, droppedTotal}`. An oversized single item is rejected without changing the variable.
- All new action/data nodes have `success` and `error` ports. Missing sourceHandle means success. Error payload: `{code, message, operation, connectionId?, sessionId?, requestId?, bytesAccepted?}`. Without an error edge, the error is logged and that execution fails.

## Serial nodes

`kind: 'serial'`, with `config.action`:

| action                   | Additional config                                                                                              | Successful output                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| scan                     | none                                                                                                           | PortSnapshot                                   |
| filter                   | `ports: ValueRef`, `vid: ValueRef`, `pid: ValueRef`                                                            | SerialPortInfo[]                               |
| open                     | `connectionId`, `settings: ValueRef`                                                                           | SerialSessionState                             |
| close                    | `connectionId`                                                                                                 | SerialSessionState                             |
| listenStart / listenStop | `connectionId`                                                                                                 | SerialSessionState                             |
| setReconnect             | `connectionId`, `enabled: ValueRef`                                                                            | SerialSessionState                             |
| resetCounters            | `connectionId`                                                                                                 | SerialSessionState                             |
| send                     | `connectionId`, `data: ValueRef`, `encoding: ValueRef`, `lineEnding: ValueRef`, optional `timeoutMs: ValueRef` | write result with `bytesAccepted` and counters |

Scan returns an object; filter's default ports source is `{source:'input', path:['ports']}`. Default VID/PID are literal empty strings. They accept empty (unrestricted), integer 0–65535, or 1–4 hexadecimal digits with optional 0x. Unknown USB metadata is null and never matches a specified ID. Both filters combine with AND.

`SerialSettings`: `portName`, `baudRate`, `dataBits`, `stopBits`, `parity`, `flowControl`, `framing`, `autoReconnect`. Defaults: 115200, 8, 1, none, none, raw, false. Merge only known profile config fields, then the resolved settings object. Profile's legacy address maps to portName. Runtime settings may not contain unrelated UI fields. Stateful operations require a declared serial connection ID. Open with identical target/settings is idempotent; incompatible settings require closing first.

Send data is a string; encoding is utf8/hex, lineEnding none/lf/crlf, timeout default 5000 ms. Hex permits contiguous digits or ASCII whitespace separators; invalid or odd-length text sends no bytes. Maximum payload 65535 bytes. Do not retry a partial write or a timeout. Successful write means OS write completion, not a device acknowledgement.

`framing` applies only to RX: raw read batches, LF-delimited lines, or big-endian length16 frames. TX always writes the encoded payload followed by the selected line ending literally; it never adds a length prefix. The older connection diagnostic retains its original framing behavior.

## Events and DTOs

- `kind:'event', config.trigger:'serial'`, `config.event:'devices'|'data'|'state'|'error'`. Connection ID is required except devices. Data additionally accepts `direction:'rx'|'tx'|'both'`, default rx. The palette exposes human-readable presets for these sources/actions.
- `kind:'event', config.trigger:'controlledInterval'`, `config.interval: ValueRef`, `config.enabled: ValueRef`. Default 1000 ms/false, allowed 100–86400000 ms. Existing interval/intervalMs remains unchanged. Read current runtime values, skip missed ticks, never accumulate sends. v4 manual run starts manual entries only; it does not fabricate serial events.
- SerialPortInfo: `{portName,portType,vid,pid,usbLocation,serialNumber,manufacturer,product,displayName}`. portType is usb/bluetooth/pci/unknown. Optional metadata is null. usbLocation is `{busId:string,portChain:number[]}` or null.
- PortSnapshot: `{kind:'snapshot'|'changed',ports,added,removed,changed,sequence,timestamp,timestampIso}`. Initial enumeration is snapshot, not insertion. Enumeration failure retains the last valid snapshot.
- SerialSessionState: `{connectionId,sessionId,status,port,autoReconnect,listening,isOpen,canOpen,canClose,counters,error,timestamp,timestampIso}`. Status is closed/opening/open/reconnecting/needsManualOpen/error. Counters: `{txBytes,rxBytes,txPackets,rxPackets}`. Error is null or the structured error above. Session ID and port may be null.
- Data event: `{kind:'data',connectionId,sessionId,sequence,timestamp,timestampIso,direction,hex,text,byteLength,counters}`. Hex is lossless uppercase byte pairs separated by spaces, text is streamed UTF-8. Raw mode exposes read batches; framed modes expose payload, with byteLength counting actual wire bytes including framing. Every successful TX emits one data event so demo logging must not append the send result again.
- State event is SerialSessionState plus `kind:'state'`; error event is the structured error plus `kind:'error'`, sequence/timestamps. Devices uses PortSnapshot. Opaque owner/flow/connection epochs belong to the internal envelope and must be checked before delivery.
- State events coalesce current session state and authoritative counters. Data payloads, including their counters, are immutable event snapshots; map/write/append never silently refresh them. The demo updates current counters from state events, so queued data cannot undo a counter reset.
- RuntimeSnapshot gains optional `serial: Record<string, SerialSessionState>`. Handles, identity baselines and counters are not project initial values.
- Tauri scan command: `serial_scan`; TS bridge: `scanSerialPorts(): Promise<PortSnapshot>` with existing project generation routing. Stateful operations run through flow host/service, not ad-hoc widget code.

## Runtime invariants

- Strict reconnect freezes `{vid,pid,canonicalPortName,usbLocation}` on manual successful open. Every field must be present and identical. Never substitute serial number or unique VID/PID. A changed selection/port/location requires manual open to establish a new baseline. Missing metadata disables auto reconnect with a reason. Default off.
- A per-owner lifetime service survives appearance-only revisions. Port actors never await Engine or a full event queue. IO suspension must release Engine state locks; continuations commit only if their execution epoch is valid. Children share their owner's service, and a process-wide occupation registry prevents competing opens.
- RX pending queue: maximum 256 batches or 1 MiB. Overflow closes the port immediately, cancels pending writes and periodic sends, latches RX_OVERFLOW, and suspends reconnect until manual open. Fault/control delivery cannot depend on the full RX queue.
- Fault/error notifications have delivery priority. Ordinary coalesced state notifications and data take turns when both are pending, so continuous counter updates cannot starve data. A failed send must retain its own error rather than re-emitting an older session error over it.
- Display history: 500 records / 512 KiB, evict oldest and count evictions. This is distinct from unprocessed data overflow. Oversized display records report omission errors without changing the original serial event.
- A scan is shared per running owner, every 1000 ms while needed. Stop/close joins IO and releases handles/reservations. Late open results are immediately closed. UI-only updates retain open handles/data; changed connection settings require manual reopen. Old cancelled executions are not replayed.
- Listen controls delivery, not an infinite flow loop. While delivery is stopped the port reader may drain/count data, but data is not buffered for replay. Demo starts listening after open and closes on disconnect. Reconnect restores listening, never periodic sending.
- Port identity and communication fields, including the demo VID/PID filters, are locked while opening, open, or reconnecting (`canOpen:false`). Disconnect before editing these fields. Counter reset affects current session totals, not already recorded history.

## Shared TS helper exports

`flowV4.ts` should export `resolveValueRef`, `mapNodeValue`, `appendNodeValue`, `filterSerialPorts`, `flowNodePorts`, `getFlowNodeReferences`, and v4 config validation. appendNodeValue returns `{variableId,value,output}` for one validated variable commit. Node references return stable variable/connection IDs, including nested ValueRefs and droppedPath's owning variable. Reuse this metadata in schema validation, deletion protection and clipboard dependency remapping.

`upgradeProject(project, minimumVersion:3|4=3)` never downgrades. Explicit v1/v2 upgrades retain existing v3 migration semantics with a clear report; old connection diagnostics do not change in v4.
