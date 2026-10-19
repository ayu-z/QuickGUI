import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSerialAssistantProject } from '../src/examples/serialAssistant';
import { validateProject } from '../src/core/validation';
import { getFlowNodeReferences, isAutomaticEventSource } from '../src/core/flowV4';
import { readJsonPath } from '../src/core/jsonValue';
import { RuntimeController } from '../src/runtime/engine';
import type { Flow, Json, Project } from '../src/core/types';

const fixture = JSON.parse(
  readFileSync(new URL('../examples/serial-assistant/quickgui.json', import.meta.url), 'utf8'),
) as Project;
const values = (engine: RuntimeController, id: string) => engine.getSnapshot().values[id].value;
const event = (engine: RuntimeController, id: string, payload: Json) =>
  engine.runFlow('serial_scan', payload, `${id}_0`);
const manual = (engine: RuntimeController, id: string) =>
  engine.runFlow('serial_scan', null, `${id}_0`);
// Exercise downstream data semantics with explicit test event adapters. Browser
// production code never injects native USB/serial events or device responses.
function semanticsProject() {
  const project = createSerialAssistantProject();
  const flow = project.flows[0];
  for (const [id, sourceId, port] of [
    ['serial_devices_0', 'serial_scan_1', 'changed'],
    ['serial_rx_0', 'serial_send_1', 'rx'],
    ['serial_tx_0', 'serial_send_1', 'tx'],
    ['serial_state_0', 'serial_send_1', 'state'],
    ['serial_errors_0', 'serial_send_1', 'error'],
  ]) {
    const source = flow.nodes.find((node) => node.id === sourceId)!;
    const starts = flow.edges.filter(
      (edge) => edge.kind !== 'data' && edge.source === sourceId && edge.sourceHandle === port,
    );
    const targets = new Set(
      starts.flatMap((edge) => reachable(flow, edge.target).map((node) => node.id)),
    );
    flow.nodes.push({
      id,
      kind: 'event',
      label: id,
      config: { trigger: 'manual' },
      position: { x: 0, y: 0 },
      block: {
        version: 1,
        inputs: [],
        outputs: source.block!.outputs.map((p) => ({ ...p, path: p.path.slice(1) })),
      },
    });
    for (const edge of flow.edges) {
      if (edge.source !== sourceId) continue;
      if (edge.kind === 'data' && targets.has(edge.target)) edge.source = id;
      if (starts.includes(edge)) {
        edge.source = id;
        edge.sourceHandle = 'output';
      }
    }
  }
  flow.nodes = flow.nodes.filter((node) => node.id !== 'serial_devices_startup');
  flow.edges = flow.edges.filter((edge) => edge.id !== 'serial_devices_watch');
  return project;
}
function reachable(flow: Flow, start: string) {
  const seen = new Set([start]),
    pending = [start];
  while (pending.length) {
    const current = pending.shift()!;
    for (const edge of flow.edges.filter((edge) => edge.source === current))
      if (!seen.has(edge.target)) {
        seen.add(edge.target);
        pending.push(edge.target);
      }
  }
  return flow.nodes.filter((node) => seen.has(node.id));
}

describe('serial assistant project contract (no physical I/O)', () => {
  it('keeps the editable source template identical to the generator and validates both locales', () => {
    const generated = createSerialAssistantProject();
    expect({ ...generated, id: fixture.id }).toEqual(fixture);
    for (const project of [fixture, generated, createSerialAssistantProject('en')]) {
      expect(validateProject(project).schemaVersion).toBe(5);
      expect(project.flows).toHaveLength(1);
      expect(project.scripts).toEqual([]);
      expect(project.modules).toEqual([]);
      expect(project.flows.flatMap((flow) => flow.nodes).every((node) => node.block)).toBe(true);
      expect(
        project.widgets.every(
          (widget) => widget.definitionVersion === 2 && widget.type !== 'module',
        ),
      ).toBe(true);
      for (const id of [
        'serial_port_select',
        'filter_vid',
        'filter_pid',
        'baud_rate',
        'data_bits',
        'parity',
        'stop_bits',
        'flow_control',
        'framing',
      ])
        expect(project.widgets.find((widget) => widget.id === id)?.bindings.enabled).toEqual({
          variable: 'serial_state',
          path: ['canOpen'],
          mode: 'oneWay',
        });
    }
  });

  it('wires independent send parameters and separate packet/time outputs without triggering extra sends', () => {
    const project = createSerialAssistantProject();
    const flow = project.flows[0];
    const send = flow.nodes.find((node) => node.id === 'serial_send_1')!;
    for (const id of ['serial_send', 'serial_periodic']) {
      expect(flow.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: `${id}_0`, target: send.id, targetHandle: 'send' }),
        ]),
      );
      expect(
        flow.edges
          .filter((edge) => edge.kind === 'data' && edge.target === send.id)
          .map((edge) => edge.targetHandle),
      ).toEqual(['data-in:p_data', 'data-in:p_encoding', 'data-in:p_lineEnding']);
      for (const read of flow.nodes.filter((node) => node.kind === 'read'))
        expect(flow.edges.some((edge) => edge.target === read.id)).toBe(false);
    }
    for (const direction of ['rx', 'tx']) {
      expect(send.block!.outputs).toContainEqual({
        id: 'time',
        name: 'TIME',
        type: 'string',
        path: ['result', 'timestampIso'],
      });
      expect(
        flow.edges.filter(
          (edge) => edge.kind === 'data' && edge.target.startsWith(`serial_${direction}_`),
        ),
      ).toHaveLength(4);
    }
  });

  it('uses complete stable references and never opens or sends from an unconditional automatic entry', () => {
    const project = createSerialAssistantProject();
    for (const flow of project.flows)
      for (const node of flow.nodes) {
        for (const reference of getFlowNodeReferences(node)) {
          expect(
            reference.kind === 'variable'
              ? project.variables.some((variable) => variable.id === reference.id)
              : reference.kind === 'connection'
                ? project.connections.some(
                    (connection) =>
                      connection.id === reference.id && connection.protocol === 'serial',
                  )
                : false,
          ).toBe(true);
        }
        if (!isAutomaticEventSource(node) || node.kind !== 'event') continue;
        const actions = reachable(flow, node.id).filter(
          (node) =>
            node.kind === 'serial' &&
            flow.edges.some(
              (edge) =>
                edge.target === node.id && ['open', 'send'].includes(String(edge.targetHandle)),
            ),
        );
        expect(
          actions.some((node) =>
            flow.edges.some((edge) => edge.target === node.id && edge.targetHandle === 'open'),
          ),
        ).toBe(false);
        if (actions.length) {
          expect(node.config.trigger).toBe('controlledInterval');
          expect(node.config.enabled).toEqual({
            source: 'variable',
            variable: 'serial_tx',
            path: ['periodic'],
          });
          expect(
            readJsonPath(
              project.variables.find((variable) => variable.id === 'serial_tx')!.initial,
              ['periodic'],
            ),
          ).toBe(false);
        }
      }
  });

  it('projects native PortSnapshot fields into options and applies both USB filters without inventing metadata', async () => {
    const engine = new RuntimeController(semanticsProject());
    try {
      const port = (name: string, vid: number | null, pid: number | null) => ({
        portName: name,
        portType: vid === null ? 'unknown' : 'usb',
        vid,
        pid,
        usbLocation: null,
        serialNumber: null,
        manufacturer: null,
        product: null,
        displayName: name,
      });
      const ports = [
        port('/dev/cu.alpha', 0x1a86, 0x7523),
        port('/dev/cu.beta', 0x1a86, 0x7524),
        port('/dev/cu.unknown', null, null),
      ];
      await event(engine, 'serial_devices', {
        kind: 'snapshot',
        ports,
        added: [],
        removed: [],
        changed: [],
        sequence: 1,
        timestamp: 1,
        timestampIso: '2026-10-19T00:00:00.001Z',
      });
      expect(values(engine, 'serial_options')).toEqual(
        ports.map((port) => ({ id: port.portName, label: port.displayName, value: port.portName })),
      );
      engine.setVariable('serial_filters', { vid: '1A86', pid: '0x7523' });
      await manual(engine, 'serial_filter');
      expect(values(engine, 'serial_options')).toEqual([
        { id: '/dev/cu.alpha', label: '/dev/cu.alpha', value: '/dev/cu.alpha' },
      ]);
      expect(values(engine, 'serial_history')).toEqual({ rows: [], dropped: 0 });
      expect(readJsonPath(values(engine, 'serial_state'), ['isOpen'])).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('records each native RX/TX event without overwriting authoritative session counters', async () => {
    const engine = new RuntimeController(semanticsProject());
    try {
      const rx = {
        kind: 'data',
        connectionId: 'serial_port',
        sessionId: 1,
        sequence: 2,
        timestamp: 1,
        timestampIso: '2026-10-19T00:00:00.001Z',
        direction: 'rx',
        hex: '41 0A',
        text: 'A\n',
        byteLength: 2,
        counters: { txBytes: 0, rxBytes: 2, txPackets: 0, rxPackets: 1 },
      };
      const tx = {
        ...rx,
        sequence: 3,
        timestamp: 2,
        timestampIso: '2026-10-19T00:00:00.002Z',
        direction: 'tx',
        hex: '42',
        text: 'B',
        byteLength: 1,
        counters: { txBytes: 1, rxBytes: 2, txPackets: 1, rxPackets: 1 },
      };
      await event(engine, 'serial_rx', rx);
      await event(engine, 'serial_tx', tx);
      expect(values(engine, 'serial_history')).toEqual({
        rows: [
          { time: rx.timestampIso, direction: 'rx', bytes: 2, text: 'A\n', hex: '41 0A' },
          { time: tx.timestampIso, direction: 'tx', bytes: 1, text: 'B', hex: '42' },
        ],
        dropped: 0,
      });
      const initialState = values(engine, 'serial_state') as Record<string, Json>;
      expect(readJsonPath(initialState, ['counters'])).toEqual({
        txBytes: 0,
        rxBytes: 0,
        txPackets: 0,
        rxPackets: 0,
      });
      await event(engine, 'serial_state', {
        ...initialState,
        kind: 'state',
        sessionId: 1,
        counters: tx.counters,
      });
      expect(readJsonPath(values(engine, 'serial_state'), ['counters'])).toEqual(tx.counters);
      expect(values(engine, 'serial_last_rx')).toBe(rx.timestampIso);
      expect(values(engine, 'serial_last_tx')).toBe(tx.timestampIso);
      const project = engine.getProject();
      const flow = project.flows[0];
      for (const edge of flow.edges.filter(
        (edge) => edge.source === 'serial_send_1' && edge.sourceHandle === 'success',
      ))
        expect(reachable(flow, edge.target).some((node) => node.kind === 'append')).toBe(false);
      // A counter reset is authoritative even if a previously queued data batch
      // still carries the pre-reset counter snapshot when it reaches the flow.
      await event(engine, 'serial_state', {
        ...initialState,
        kind: 'state',
        sessionId: 1,
        sequence: 5,
      });
      await event(engine, 'serial_rx', { ...rx, sequence: 4, hex: '43', text: 'C', byteLength: 1 });
      expect(readJsonPath(values(engine, 'serial_state'), ['counters'])).toEqual(
        initialState.counters,
      );
      expect(readJsonPath(values(engine, 'serial_history'), ['rows'])).toHaveLength(3);
      for (const id of ['serial_rx', 'serial_tx'])
        expect(
          reachable(flow, `${id}_0`).some(
            (node) => node.kind === 'write' && node.config.variable === 'serial_state',
          ),
        ).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('renders code/message faults and stops periodic sends on faults or non-open states', async () => {
    const engine = new RuntimeController(semanticsProject());
    try {
      engine.setVariable('serial_tx', true, ['periodic']);
      await event(engine, 'serial_errors', {
        kind: 'error',
        code: 'RX_OVERFLOW',
        message: 'Receive queue overflow',
        operation: 'serial',
        connectionId: 'serial_port',
        sessionId: 1,
        bytesAccepted: 0,
        sequence: 4,
        timestamp: 3,
        timestampIso: '2026-10-19T00:00:00.003Z',
      });
      expect(values(engine, 'serial_error')).toEqual({
        code: 'RX_OVERFLOW',
        message: 'Receive queue overflow',
      });
      expect(readJsonPath(values(engine, 'serial_tx'), ['periodic'])).toBe(false);
      engine.setVariable('serial_tx', true, ['periodic']);
      const state = {
        ...(values(engine, 'serial_state') as Record<string, Json>),
        kind: 'state',
        sessionId: 1,
        status: 'needsManualOpen',
        isOpen: false,
        canOpen: true,
        canClose: false,
        listening: false,
        error: {
          code: 'RX_OVERFLOW',
          message: 'Receive queue overflow',
          operation: 'serial',
          bytesAccepted: 0,
        },
      };
      await event(engine, 'serial_state', state);
      expect(values(engine, 'serial_state')).toEqual(state);
      expect(readJsonPath(values(engine, 'serial_tx'), ['periodic'])).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('keeps initial state disconnected and browser scanning reports capability failure without fake ports or traffic', async () => {
    const engine = new RuntimeController(semanticsProject());
    try {
      expect(values(engine, 'serial_state')).toMatchObject({
        sessionId: null,
        port: null,
        status: 'closed',
        isOpen: false,
        canOpen: true,
        canClose: false,
        listening: false,
      });
      await manual(engine, 'serial_scan');
      expect(values(engine, 'serial_error')).toMatchObject({ code: 'NATIVE_SERIAL_REQUIRED' });
      expect(values(engine, 'serial_options')).toEqual([]);
      expect(values(engine, 'serial_history')).toEqual({ rows: [], dropped: 0 });
      expect(readJsonPath(values(engine, 'serial_state'), ['isOpen'])).toBe(false);
    } finally {
      engine.dispose();
    }
  });
});
