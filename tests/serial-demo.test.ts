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
  engine.runFlow(id, payload, `${id}_0`);
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
      expect(validateProject(project).schemaVersion).toBe(4);
      expect(project.flows).toHaveLength(16);
      expect(project.scripts).toEqual([]);
      expect(project.modules).toEqual([]);
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
        if (!isAutomaticEventSource(node)) continue;
        const actions = reachable(flow, node.id).filter(
          (node) => node.kind === 'serial' && ['open', 'send'].includes(String(node.config.action)),
        );
        expect(actions.some((node) => node.config.action === 'open')).toBe(false);
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
    const engine = new RuntimeController(createSerialAssistantProject());
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
      await engine.runFlow('serial_filter');
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
    const engine = new RuntimeController(createSerialAssistantProject());
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
      for (const id of ['serial_send', 'serial_periodic'])
        expect(
          project.flows
            .find((flow) => flow.id === id)!
            .nodes.some((node) => node.kind === 'append'),
        ).toBe(false);
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
          project.flows
            .find((flow) => flow.id === id)!
            .nodes.some((node) => node.kind === 'write' && node.config.variable === 'serial_state'),
        ).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('renders code/message faults and stops periodic sends on faults or non-open states', async () => {
    const engine = new RuntimeController(createSerialAssistantProject());
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
    const engine = new RuntimeController(createSerialAssistantProject());
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
      await engine.runFlow('serial_scan');
      expect(values(engine, 'serial_error')).toMatchObject({ code: 'NATIVE_SERIAL_REQUIRED' });
      expect(values(engine, 'serial_options')).toEqual([]);
      expect(values(engine, 'serial_history')).toEqual({ rows: [], dropped: 0 });
      expect(readJsonPath(values(engine, 'serial_state'), ['isOpen'])).toBe(false);
    } finally {
      engine.dispose();
    }
  });
});
