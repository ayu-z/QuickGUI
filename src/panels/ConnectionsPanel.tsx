import { useState } from 'react';
import { Activity, Plus, Radio, Trash2 } from 'lucide-react';
import type { Connection, Json, Project } from '../core/types';
import { uid } from '../core/project';
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
export function ConnectionsPanel({
  project,
  onChange,
  notify,
}: {
  project: Project;
  onChange: (mutator: (p: Project) => void) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const zh = project.locale === 'zh-CN';
  const [response, setResponse] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const change = (id: string, key: string, value: Json) =>
    onChange((p) => {
      p.connections.find((c) => c.id === id)!.config[key] = value;
    });
  const test = async (connection: Connection) => {
    setBusy((p) => ({ ...p, [connection.id]: true }));
    try {
      if (native.isDesktop()) {
        const result = await native.testConnection(connection);
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
                onClick={() =>
                  onChange((p) => {
                    p.connections = p.connections.filter((x) => x.id !== c.id);
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </header>
            <label>
              {zh ? '协议' : 'Protocol'}
              <select
                value={c.protocol}
                onChange={(e) =>
                  onChange((p) => {
                    const item = p.connections.find((x) => x.id === c.id)!;
                    item.protocol = e.target.value as Connection['protocol'];
                    item.config = { ...defaults[item.protocol] };
                  })
                }
              >
                {Object.keys(defaults).map((protocol) => (
                  <option key={protocol}>{protocol}</option>
                ))}
              </select>
            </label>
            <label>
              {c.protocol === 'serial' ? (zh ? '设备端口' : 'Device port') : 'URL'}
              <input
                value={String(c.config[c.protocol === 'serial' ? 'address' : 'url'] ?? '')}
                onChange={(e) =>
                  change(c.id, c.protocol === 'serial' ? 'address' : 'url', e.target.value)
                }
              />
            </label>
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
                  value={Number(c.config.baudRate ?? 9600)}
                  onChange={(e) => change(c.id, 'baudRate', Number(e.target.value))}
                />
              </label>
            )}
            {['tcp', 'serial'].includes(c.protocol) && (
              <label>
                {zh ? '组帧' : 'Framing'}
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
            <button className="button" disabled={busy[c.id]} onClick={() => void test(c)}>
              <Activity size={14} />
              {busy[c.id] ? (zh ? '连接中…' : 'Connecting…') : zh ? '连接并测试' : 'Connect & test'}
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
