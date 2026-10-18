import { useState } from 'react';
import { Activity, Plus, Radio, Trash2 } from 'lucide-react';
import type { Connection, Json, Project, SerialPortInfo } from '../core/types';
import { uid } from '../core/project';
import { getFlowNodeReferences } from '../core/flowV4';
import * as native from '../native/bridge';

const defaults: Record<Connection['protocol'], Record<string, Json>> = {
  http: { url: 'http://127.0.0.1:8080', method: 'GET', timeoutMs: 5000 },
  websocket: { url: 'ws://127.0.0.1:8080', message: '', timeoutMs: 5000 },
  mqtt: {
    url: 'mqtt://127.0.0.1:1883',
    topic: 'quickgui/data',
    action: 'connect',
    payload: '',
    timeoutMs: 5000,
  },
  tcp: { url: 'tcp://127.0.0.1:9000', message: '', framing: 'line', timeoutMs: 5000 },
  serial: { address: '', baudRate: 9600, message: '', framing: 'line', timeoutMs: 5000 },
};
const serialDefaults: Record<string, Json> = {
  portName: '',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  framing: 'raw',
  autoReconnect: false,
};
const diagnosticCompatible = (connection: Connection) =>
  connection.protocol !== 'serial' ||
  ((connection.config.dataBits ?? 8) === 8 &&
    (connection.config.stopBits ?? 1) === 1 &&
    (connection.config.parity ?? 'none') === 'none' &&
    (connection.config.flowControl ?? 'none') === 'none');
export function ConnectionsPanel({
  project,
  onChange,
  notify,
  onRequestV4,
}: {
  project: Project;
  onChange: (mutator: (p: Project) => void) => void;
  notify: (text: string, error?: boolean) => void;
  onRequestV4?: (apply: () => void) => void;
}) {
  const zh = project.locale === 'zh-CN';
  const [response, setResponse] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const scan = async (id: string) => {
    setScanning(true);
    try {
      const snapshot = await native.scanSerialPorts();
      setPorts(snapshot.ports);
      setResponse((previous) => ({
        ...previous,
        [id]: zh
          ? `发现 ${snapshot.ports.length} 个串口。扫描不会打开端口。`
          : `Found ${snapshot.ports.length} serial ports. Scanning does not open a port.`,
      }));
    } catch (error) {
      const message = String(error);
      setResponse((previous) => ({ ...previous, [id]: message }));
      notify(message, true);
    } finally {
      setScanning(false);
    }
  };
  const setProtocol = (id: string, protocol: Connection['protocol']) => {
    if (
      protocol !== 'serial' &&
      project.flows.some((flow) =>
        flow.nodes.some(
          (node) =>
            (node.kind === 'serial' ||
              (node.kind === 'event' && node.config.trigger === 'serial')) &&
            getFlowNodeReferences(node).some(
              (reference) => reference.kind === 'connection' && reference.id === id,
            ),
        ),
      )
    ) {
      notify(
        zh
          ? '该连接被串口流程引用，请先移除引用再更改协议。'
          : 'Remove serial flow references before changing this protocol.',
        true,
      );
      return;
    }
    const apply = () =>
      onChange((next) => {
        const connection = next.connections.find((item) => item.id === id)!;
        connection.protocol = protocol;
        connection.config = { ...(protocol === 'serial' ? serialDefaults : defaults[protocol]) };
      });
    if (protocol === 'serial' && project.schemaVersion < 4) onRequestV4?.(apply);
    else apply();
  };
  const change = (id: string, key: string, value: Json) =>
    onChange((p) => {
      p.connections.find((c) => c.id === id)!.config[key] = value;
    });
  const test = async (connection: Connection) => {
    setBusy((p) => ({ ...p, [connection.id]: true }));
    try {
      if (native.isDesktop()) {
        const diagnostic =
          connection.protocol === 'serial' && connection.config.portName !== undefined
            ? {
                ...connection,
                config: { ...connection.config, address: connection.config.portName },
              }
            : connection;
        const result = await native.testConnection(diagnostic);
        setResponse((p) => ({ ...p, [connection.id]: JSON.stringify(result, null, 2) }));
      } else if (connection.protocol === 'http') {
        const url = new URL(String(connection.config.url));
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP(S) URL required');
        const r = await fetch(url, {
          method: String(connection.config.method ?? 'GET'),
          signal: AbortSignal.timeout(Number(connection.config.timeoutMs ?? 5000)),
        });
        const body = (await r.text()).slice(0, 4096);
        setResponse((p) => ({ ...p, [connection.id]: `HTTP ${r.status}\n${body}` }));
      } else
        throw new Error(
          zh
            ? '此协议使用原生驱动，请在 QuickGUI 桌面版测试。'
            : 'This protocol uses native drivers. Open the desktop app to test.',
        );
    } catch (error) {
      const message = String(error);
      setResponse((p) => ({ ...p, [connection.id]: message }));
      notify(message, true);
    } finally {
      setBusy((p) => ({ ...p, [connection.id]: false }));
    }
  };
  return (
    <div className="data-panel">
      <header className="page-heading">
        <div>
          <span className="eyebrow">CONNECTIONS</span>
          <h2>{zh ? '设备与服务' : 'Devices & services'}</h2>
          <p>
            {zh
              ? '显式连接、受控收发与超时诊断。连接配置随工程保存。'
              : 'Explicit connections, bounded I/O and timeout diagnostics. Settings travel with your project.'}
          </p>
        </div>
        <button
          className="button primary"
          onClick={() =>
            onChange((p) =>
              p.connections.push({
                id: uid('connection'),
                name: 'HTTP service',
                protocol: 'http',
                config: { ...defaults.http },
              }),
            )
          }
        >
          <Plus size={14} />
          {zh ? '添加连接' : 'Add connection'}
        </button>
      </header>
      <div className="connections-grid">
        {project.connections.map((c) => (
          <div className="connection-card" key={c.id}>
            <header>
              <Radio size={18} />
              <input
                aria-label="Connection name"
                value={c.name}
                onChange={(e) =>
                  onChange((p) => {
                    p.connections.find((x) => x.id === c.id)!.name = e.target.value;
                  })
                }
              />
              <button
                className="icon-button"
                aria-label="Delete connection"
                onClick={() => {
                  const references = project.flows.filter((flow) =>
                    flow.nodes.some((node) =>
                      getFlowNodeReferences(node).some(
                        (reference) => reference.kind === 'connection' && reference.id === c.id,
                      ),
                    ),
                  );
                  if (references.length) {
                    notify(
                      `${zh ? '连接被流程引用，请先移除引用' : 'Remove flow references before deleting this connection'}: ${references.map((flow) => flow.name).join(', ')}`,
                      true,
                    );
                    return;
                  }
                  onChange((p) => {
                    p.connections = p.connections.filter((x) => x.id !== c.id);
                  });
                }}
              >
                <Trash2 size={14} />
              </button>
            </header>
            <label>
              {zh ? '协议' : 'Protocol'}
              <select
                value={c.protocol}
                onChange={(e) => setProtocol(c.id, e.target.value as Connection['protocol'])}
              >
                {Object.keys(defaults).map((protocol) => (
                  <option key={protocol}>{protocol}</option>
                ))}
              </select>
            </label>
            <label>
              {c.protocol === 'serial' ? (zh ? '设备端口' : 'Device port') : 'URL'}
              <input
                value={String(
                  c.config[
                    c.protocol === 'serial'
                      ? c.config.portName !== undefined
                        ? 'portName'
                        : 'address'
                      : 'url'
                  ] ?? '',
                )}
                onChange={(e) =>
                  change(
                    c.id,
                    c.protocol === 'serial'
                      ? c.config.portName !== undefined
                        ? 'portName'
                        : 'address'
                      : 'url',
                    e.target.value,
                  )
                }
              />
            </label>
            {c.protocol === 'serial' && (
              <>
                <button className="button" disabled={scanning} onClick={() => void scan(c.id)}>
                  <Radio size={14} />
                  {scanning
                    ? zh
                      ? '扫描中…'
                      : 'Scanning…'
                    : zh
                      ? '扫描串口'
                      : 'Scan serial ports'}
                </button>
                {ports.length > 0 && (
                  <label>
                    {zh ? '已检测端口' : 'Detected ports'}
                    <select
                      aria-label={zh ? '已检测端口' : 'Detected ports'}
                      value={String(c.config.portName ?? c.config.address ?? '')}
                      onChange={(event) =>
                        change(
                          c.id,
                          c.config.portName !== undefined ? 'portName' : 'address',
                          event.target.value,
                        )
                      }
                    >
                      <option value="">{zh ? '选择端口' : 'Choose port'}</option>
                      {ports.map((port) => (
                        <option key={port.portName} value={port.portName}>
                          {port.displayName} · {port.portName}
                          {port.vid !== null && port.pid !== null
                            ? ` · ${port.vid.toString(16).padStart(4, '0')}:${port.pid.toString(16).padStart(4, '0')}`
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {project.schemaVersion < 4 && (
                  <button
                    className="button"
                    onClick={() =>
                      onRequestV4?.(() =>
                        onChange((next) => {
                          const connection = next.connections.find((item) => item.id === c.id)!;
                          connection.config = {
                            ...serialDefaults,
                            portName: String(connection.config.address ?? ''),
                            baudRate: connection.config.baudRate ?? 115200,
                            framing: connection.config.framing ?? 'raw',
                          };
                        }),
                      )
                    }
                  >
                    {zh ? '升级为完整串口配置（v4）' : 'Upgrade to full serial settings (v4)'}
                  </button>
                )}
              </>
            )}
            {c.protocol === 'http' && (
              <label>
                Method
                <select
                  value={String(c.config.method ?? 'GET')}
                  onChange={(e) => change(c.id, 'method', e.target.value)}
                >
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((method) => (
                    <option key={method}>{method}</option>
                  ))}
                </select>
              </label>
            )}
            {c.protocol === 'serial' && (
              <label>
                {zh ? '波特率' : 'Baud rate'}
                <input
                  type="number"
                  min={1}
                  max={4000000}
                  step={1}
                  value={Number(c.config.baudRate ?? 9600)}
                  onChange={(e) => change(c.id, 'baudRate', Number(e.target.value))}
                />
              </label>
            )}
            {c.protocol === 'serial' && project.schemaVersion >= 4 && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {(
                    [
                      ['dataBits', zh ? '数据位' : 'Data bits', [5, 6, 7, 8]],
                      ['stopBits', zh ? '停止位' : 'Stop bits', [1, 2]],
                      ['parity', zh ? '校验' : 'Parity', ['none', 'odd', 'even']],
                      [
                        'flowControl',
                        zh ? '流控' : 'Flow control',
                        ['none', 'hardware', 'software'],
                      ],
                    ] as const
                  ).map(([key, label, options]) => (
                    <label
                      key={key}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'stretch',
                        gap: 6,
                      }}
                    >
                      {label}
                      <select
                        value={String(c.config[key] ?? serialDefaults[key])}
                        onChange={(event) =>
                          change(
                            c.id,
                            key,
                            key === 'dataBits' || key === 'stopBits'
                              ? Number(event.target.value)
                              : event.target.value,
                          )
                        }
                      >
                        {options.map((option) => (
                          <option key={option} value={option}>
                            {String(option)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <label style={{ display: 'block' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto', flex: 'none' }}
                      checked={c.config.autoReconnect === true}
                      onChange={(event) => change(c.id, 'autoReconnect', event.target.checked)}
                    />{' '}
                    {zh ? '严格同设备自动重连' : 'Strict same-device auto reconnect'}
                  </span>
                </label>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6 }}>
                  {zh
                    ? '默认关闭。VID、PID、规范端口名及 USB 物理拓扑必须完全相同；缺失信息时只能手动打开。运行中的参数变更需要关闭后手动重开。'
                    : 'Off by default. VID, PID, canonical port and USB topology must all match. Missing identity requires manual open. Changed active settings require closing and manually reopening.'}
                </p>
              </>
            )}
            {['tcp', 'serial'].includes(c.protocol) && (
              <label>
                {c.protocol === 'serial' && project.schemaVersion >= 4
                  ? zh
                    ? '接收组帧'
                    : 'Receive framing'
                  : zh
                    ? '组帧'
                    : 'Framing'}
                <select
                  value={String(c.config.framing ?? 'line')}
                  onChange={(e) => change(c.id, 'framing', e.target.value)}
                >
                  <option value="raw">Raw</option>
                  <option value="line">Newline</option>
                  <option value="length16">16-bit length prefix</option>
                </select>
              </label>
            )}
            {c.protocol === 'serial' && project.schemaVersion >= 4 && (
              <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6 }}>
                {zh
                  ? 'v4 串口流程的组帧仅作用于接收；发送由编码和行尾决定。下方旧单次诊断仍按原有组帧规则收发。'
                  : 'v4 framing only affects reception. Sends use encoding and line endings. The legacy one-shot diagnostic below retains its original send/receive framing rules.'}
              </p>
            )}
            {c.protocol === 'mqtt' && (
              <>
                <label>
                  {zh ? '操作' : 'Action'}
                  <select
                    value={String(c.config.action ?? 'connect')}
                    onChange={(e) => change(c.id, 'action', e.target.value)}
                  >
                    <option value="connect">Connect</option>
                    <option value="publish">Publish</option>
                    <option value="subscribe">Subscribe once</option>
                  </select>
                </label>
                <label>
                  Topic
                  <input
                    value={String(c.config.topic ?? '')}
                    onChange={(e) => change(c.id, 'topic', e.target.value)}
                  />
                </label>
              </>
            )}
            {c.protocol !== 'http' && (
              <label>
                {zh ? '发送内容' : 'Message'}
                <input
                  value={String(c.config[c.protocol === 'mqtt' ? 'payload' : 'message'] ?? '')}
                  onChange={(e) =>
                    change(c.id, c.protocol === 'mqtt' ? 'payload' : 'message', e.target.value)
                  }
                  placeholder={zh ? '留空仅连接/接收' : 'Empty for connect / receive'}
                />
              </label>
            )}
            <label>
              {zh ? '超时 / ms' : 'Timeout / ms'}
              <input
                type="number"
                min="100"
                max="30000"
                value={Number(c.config.timeoutMs ?? 5000)}
                onChange={(e) =>
                  change(c.id, 'timeoutMs', Math.min(30000, Math.max(100, Number(e.target.value))))
                }
              />
            </label>
            {c.protocol === 'serial' && !diagnosticCompatible(c) && (
              <p style={{ color: 'var(--muted)', fontSize: 11 }}>
                {zh
                  ? '旧单次诊断仅支持 8N1 / 无流控。当前参数请通过 v4 串口打开/收发流程验证。'
                  : 'Legacy diagnostics only support 8N1 / no flow control. Validate these settings with v4 serial open/send/receive flows.'}
              </p>
            )}
            <button
              className="button"
              disabled={busy[c.id] || !diagnosticCompatible(c)}
              onClick={() => void test(c)}
            >
              <Activity size={14} />
              {busy[c.id]
                ? zh
                  ? '连接中…'
                  : 'Connecting…'
                : c.protocol === 'serial' && project.schemaVersion >= 4
                  ? zh
                    ? '单次诊断（8N1 / 无流控）'
                    : 'One-shot diagnostic (8N1 / no flow control)'
                  : zh
                    ? '连接并测试'
                    : 'Connect & test'}
            </button>
            {response[c.id] && <pre>{response[c.id]}</pre>}
          </div>
        ))}
        {!project.connections.length && (
          <div className="empty-state">
            <Radio size={36} />
            <h3>{zh ? '连接你的设备' : 'Connect your devices'}</h3>
            <p>HTTP · WebSocket · MQTT · Serial · TCP</p>
          </div>
        )}
      </div>
    </div>
  );
}
