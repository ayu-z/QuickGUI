import { useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BackgroundVariant,
  type Node,
  type NodeProps,
  type Connection as FlowConnection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Binary,
  Clock3,
  Code2,
  GitBranch,
  Globe,
  MessageSquare,
  PanelsTopLeft,
  Plus,
  Radio,
  Trash2,
  Zap,
} from 'lucide-react';
import type { Flow, FlowNode, Json, Locale, NodeKind, Project } from '../core/types';
import { Field, NumberInput, Toggle } from './Fields';
import { listProjectWindows } from '../core/windows';
import { JsonValueField } from '../panels/JsonValueField';
import { assertJsonPath } from '../core/jsonValue';
import type { JsonPath } from '../core/types';
import { createFlowNodeConfig, flowNodePorts, type SerialAction } from '../core/flowV4';
import { FlowMapFieldsEditor, FlowValueRefEditor } from './FlowValueRefEditor';
import '@xyflow/react/dist/style.css';
import './designer.css';

const nodeInfo: Record<NodeKind, { icon: typeof Zap; zh: string; en: string; color: string }> = {
  event: { icon: Zap, zh: '事件入口', en: 'Event', color: '#a78bfa' },
  read: { icon: ArrowDownToLine, zh: '读取变量', en: 'Read', color: '#60a5fa' },
  write: { icon: ArrowUpFromLine, zh: '写入变量', en: 'Write', color: '#34d399' },
  condition: { icon: GitBranch, zh: '条件判断', en: 'Condition', color: '#fbbf24' },
  math: { icon: Binary, zh: '数学运算', en: 'Math', color: '#22d3ee' },
  delay: { icon: Clock3, zh: '延时', en: 'Delay', color: '#fb923c' },
  log: { icon: MessageSquare, zh: '输出日志', en: 'Log', color: '#94a3b8' },
  script: { icon: Code2, zh: 'C 脚本', en: 'C script', color: '#e879f9' },
  http: { icon: Globe, zh: 'HTTP 请求', en: 'HTTP', color: '#38bdf8' },
  emit: { icon: Radio, zh: '发送事件', en: 'Emit', color: '#f472b6' },
  connection: { icon: Globe, zh: '设备请求', en: 'Device request', color: '#2dd4bf' },
  window: { icon: PanelsTopLeft, zh: '窗口操作', en: 'Window', color: '#a78bfa' },
  serial: { icon: Radio, zh: '串口操作', en: 'Serial', color: '#2dd4bf' },
  map: { icon: Binary, zh: '数据映射', en: 'Map data', color: '#60a5fa' },
  append: { icon: ArrowDownToLine, zh: '有界追加', en: 'Bounded append', color: '#34d399' },
};
const serialActions = [
  ['scan', '扫描串口', 'Scan serial ports'],
  ['filter', 'VID/PID 过滤', 'VID/PID filter'],
  ['open', '打开串口', 'Open serial port'],
  ['close', '关闭串口', 'Close serial port'],
  ['listenStart', '开始监听', 'Start listening'],
  ['listenStop', '停止监听', 'Stop listening'],
  ['send', '串口发送', 'Serial send'],
  ['setReconnect', '设置重连', 'Set reconnect'],
  ['resetCounters', '重置串口计数', 'Reset serial counters'],
] as const;
type QuickNode = Node<{ model: FlowNode; active: boolean; locale: Locale }, 'quickgui'>;
function FlowCard({ data, selected }: NodeProps<QuickNode>) {
  const { model, active, locale } = data,
    info = nodeInfo[model.kind],
    Icon = info.icon,
    ports = flowNodePorts(model);
  const detail =
    model.kind === 'event'
      ? model.config.trigger === 'serial'
        ? `Serial · ${model.config.event} ${model.config.connectionId ?? ''}`
        : model.config.trigger === 'controlledInterval'
          ? locale === 'zh-CN'
            ? '受控定时 · 动态间隔'
            : 'Controlled interval'
          : model.config.trigger === 'interval'
            ? `${model.config.intervalMs ?? 1000} ms`
            : model.config.trigger === 'startup'
              ? locale === 'zh-CN'
                ? '运行时启动'
                : 'Runtime startup'
              : locale === 'zh-CN'
                ? '等待 UI 事件'
                : 'Waiting for UI event'
      : model.kind === 'serial'
        ? `${serialActions.find((action) => action[0] === model.config.action)?.[locale === 'zh-CN' ? 1 : 2] ?? model.config.action} · ${model.config.connectionId ?? ''}`
        : model.kind === 'map'
          ? String(model.config.operation ?? 'value')
          : model.kind === 'append'
            ? `${model.config.variable ?? '—'} · ${model.config.maxItems ?? 500}`
            : model.kind === 'read' || model.kind === 'write'
              ? String(model.config.variable || '—')
              : model.kind === 'delay'
                ? `${model.config.ms ?? 250} ms`
                : model.kind === 'condition'
                  ? `${model.config.operator ?? 'gt'} ${model.config.value ?? 0}`
                  : model.kind === 'math'
                    ? `${model.config.operation ?? 'add'} ${model.config.operand ?? 1}`
                    : model.kind === 'window'
                      ? `${model.config.action} · ${model.config.windowId}`
                      : String(
                          model.config.message ||
                            model.config.scriptId ||
                            model.config.connectionId ||
                            model.config.url ||
                            model.config.event ||
                            (locale === 'zh-CN' ? '点击配置' : 'Click to configure'),
                        );
  return (
    <div
      className={`qg-flow-card ${selected ? 'selected' : ''} ${active ? 'running' : ''}`}
      style={{ '--node-color': info.color } as React.CSSProperties}
    >
      {ports.inputs.map((port) => (
        <Handle key={port} type="target" position={Position.Left} id={port} />
      ))}
      <div className="qg-flow-card-header">
        <span className="qg-node-icon">
          <Icon size={16} />
        </span>
        <span>{model.label}</span>
        {active && <Activity size={13} className="qg-node-active" />}
      </div>
      <div className="qg-flow-card-detail">{detail}</div>
      {ports.outputs.map((port, index) => (
        <span key={port}>
          {ports.outputs.length > 1 && (
            <span className={`qg-handle-label ${index ? 'false' : 'true'}`}>{port}</span>
          )}
          <Handle
            type="source"
            position={Position.Right}
            id={port}
            style={
              ports.outputs.length > 1
                ? { top: index ? '78%' : '42%', background: index ? '#f87171' : '#34d399' }
                : undefined
            }
          />
        </span>
      ))}
    </div>
  );
}
const nodeTypes = { quickgui: FlowCard };
const id = () => crypto.randomUUID();

export interface FlowEditorProps {
  project: Project;
  onChange: (flows: Flow[]) => void;
  activeNodes?: string[];
  locale: Locale;
  onRequestUpgrade?: (apply: () => void) => void;
  onRequestV4?: (apply: () => void) => void;
}
export function FlowEditor({
  project,
  onChange,
  activeNodes = [],
  locale,
  onRequestUpgrade,
  onRequestV4,
}: FlowEditorProps) {
  const [selectedFlowId, setSelectedFlowId] = useState(project.flows[0]?.id ?? '');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const currentFlows = useRef(project.flows);
  currentFlows.current = project.flows;
  const flow = project.flows.find((item) => item.id === selectedFlowId) ?? project.flows[0];
  const selectedNode = flow?.nodes.find((node) => node.id === selectedNodeId);
  const zh = locale === 'zh-CN';
  const updateFlow = (patch: Partial<Flow>) => {
    if (!flow) return;
    const nextFlows = currentFlows.current.map((item) => {
      if (item.id !== flow.id) return item;
      const next = { ...item, ...patch },
        nodeIds = new Set(next.nodes.map((node) => node.id));
      return {
        ...next,
        edges: next.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
      };
    });
    currentFlows.current = nextFlows;
    onChange(nextFlows);
  };
  const updateNode = (patch: Partial<FlowNode>) => {
    if (selectedNode && flow)
      updateFlow({
        nodes: flow.nodes.map((node) =>
          node.id === selectedNode.id ? { ...node, ...patch } : node,
        ),
      });
  };
  const updateConfig = (key: string, value: Json) => {
    if (selectedNode) updateNode({ config: { ...selectedNode.config, [key]: value } });
  };
  const newFlow = () => {
    const flowId = id();
    onChange([
      ...project.flows,
      {
        id: flowId,
        name: `${zh ? '新流程' : 'New flow'} ${project.flows.length + 1}`,
        enabled: true,
        nodes: [
          {
            id: id(),
            kind: 'event',
            label: zh ? '事件入口' : 'Event',
            position: { x: 60, y: 180 },
            config: { trigger: 'manual' },
          },
        ],
        edges: [],
      },
    ]);
    setSelectedFlowId(flowId);
    setSelectedNodeId(null);
  };
  const addNode = (kind: NodeKind, preset?: Record<string, Json>) => {
    if (!flow) return;
    const apply = () => {
      const node: FlowNode = {
        id: id(),
        kind,
        label: nodeInfo[kind][zh ? 'zh' : 'en'],
        config: {
          ...createFlowNodeConfig(
            kind,
            project,
            typeof preset?.action === 'string' ? (preset.action as SerialAction) : undefined,
          ),
          ...preset,
        },
        position: {
          x: 80 + (flow.nodes.length % 4) * 245,
          y: 100 + Math.floor(flow.nodes.length / 4) * 160,
        },
      };
      updateFlow({ nodes: [...flow.nodes, node] });
      setSelectedNodeId(node.id);
    };
    if (
      project.schemaVersion < 4 &&
      (['serial', 'map', 'append'].includes(kind) ||
        ['serial', 'controlledInterval'].includes(String(preset?.trigger)))
    )
      onRequestV4?.(apply);
    else apply();
  };
  const onConnect = (connection: FlowConnection) => {
    if (!flow || !connection.source || !connection.target || !canConnect(connection)) return;
    if (
      flow.edges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          (edge.sourceHandle || 'output') === (connection.sourceHandle || 'output'),
      )
    )
      return;
    updateFlow({
      edges: [
        ...flow.edges,
        {
          id: id(),
          source: connection.source,
          target: connection.target,
          sourceHandle:
            connection.sourceHandle ??
            flowNodePorts(flow.nodes.find((node) => node.id === connection.source)!).defaultOutput,
          targetHandle: connection.targetHandle ?? 'input',
        },
      ],
    });
  };
  const canConnect = ({
    source,
    target,
    sourceHandle,
    targetHandle,
  }: {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }) => {
    if (
      !flow ||
      source === target ||
      flow.nodes.find((node) => node.id === target)?.kind === 'event'
    )
      return false;
    const sourceNode = flow.nodes.find((node) => node.id === source),
      targetNode = flow.nodes.find((node) => node.id === target);
    if (
      !sourceNode ||
      !targetNode ||
      (sourceHandle && !flowNodePorts(sourceNode).outputs.includes(sourceHandle)) ||
      (targetHandle && !flowNodePorts(targetNode).inputs.includes(targetHandle))
    )
      return false;
    const pending = [target],
      visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === source) return false;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(
        ...flow.edges.filter((edge) => edge.source === current).map((edge) => edge.target),
      );
    }
    return true;
  };
  const onNodesChange = (changes: NodeChange<QuickNode>[]) => {
    if (!flow) return;
    for (const change of changes)
      if (change.type === 'dimensions' && change.dimensions) {
        const dimensions = change.dimensions;
        setMeasurements((previous) =>
          previous[change.id]?.width === dimensions.width &&
          previous[change.id]?.height === dimensions.height
            ? previous
            : { ...previous, [change.id]: dimensions },
        );
      }
    const selection = changes.find((change) => change.type === 'select' && change.selected);
    if (selection?.type === 'select') {
      setSelectedNodeId(selection.id);
      setSelectedEdgeId(null);
    }
    const changesToApply = changes.filter(
      (change) => change.type === 'remove' || (change.type === 'position' && !!change.position),
    );
    if (!changesToApply.length) return;
    let nodes = flow.nodes;
    for (const change of changesToApply) {
      if (change.type === 'remove') nodes = nodes.filter((node) => node.id !== change.id);
      if (change.type === 'position' && change.position)
        nodes = nodes.map((node) =>
          node.id === change.id ? { ...node, position: change.position! } : node,
        );
    }
    const ids = new Set(nodes.map((node) => node.id));
    updateFlow({
      nodes,
      edges: flow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    });
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    if (!flow) return;
    const selection = changes.find((change) => change.type === 'select' && change.selected);
    if (selection?.type === 'select') {
      setSelectedEdgeId(selection.id);
      setSelectedNodeId(null);
    }
    const removed = new Set(
      changes.filter((change) => change.type === 'remove').map((change) => change.id),
    );
    if (removed.size) {
      updateFlow({ edges: flow.edges.filter((edge) => !removed.has(edge.id)) });
      setSelectedEdgeId(null);
    }
  };
  const deleteSelectedNode = () => {
    if (flow && selectedNode) {
      updateFlow({
        nodes: flow.nodes.filter((node) => node.id !== selectedNode.id),
        edges: flow.edges.filter(
          (edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id,
        ),
      });
      setSelectedNodeId(null);
    }
  };
  return (
    <div className="qg-flow-editor">
      <div className="qg-flow-toolbar">
        <div className="qg-toolbar-cluster">
          <GitBranch size={17} />
          <select
            aria-label={zh ? '选择流程' : 'Select flow'}
            value={flow?.id ?? ''}
            onChange={(event) => {
              setSelectedFlowId(event.target.value);
              setSelectedNodeId(null);
            }}
          >
            {project.flows.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            className="qg-icon-button"
            onClick={newFlow}
            aria-label={zh ? '新增流程' : 'Add flow'}
          >
            <Plus size={15} />
          </button>
        </div>
        <span className="qg-flow-caption">
          {zh ? '连接节点，让界面拥有逻辑' : 'Connect nodes. Bring your interface to life.'}
        </span>
      </div>
      <div className="qg-node-palette">
        {(Object.keys(nodeInfo) as NodeKind[])
          .filter((kind) => kind !== 'serial')
          .map((kind) => {
            const info = nodeInfo[kind];
            return (
              <button
                key={kind}
                disabled={!flow}
                onClick={() => addNode(kind)}
                title={zh ? `添加${info.zh}` : `Add ${info.en}`}
              >
                <info.icon size={14} style={{ color: info.color }} />
                <span>{info[zh ? 'zh' : 'en']}</span>
              </button>
            );
          })}
        {serialActions.map(([action, cn, en]) => (
          <button
            key={action}
            disabled={!flow}
            onClick={() => addNode('serial', { action })}
            title={zh ? cn : en}
          >
            <Radio size={14} style={{ color: '#2dd4bf' }} />
            <span>{zh ? cn : en}</span>
          </button>
        ))}
        {(['devices', 'data', 'state', 'error'] as const).map((event, index) => (
          <button
            key={event}
            disabled={!flow}
            onClick={() =>
              addNode('event', {
                trigger: 'serial',
                event,
                ...(event === 'devices'
                  ? {}
                  : {
                      connectionId:
                        project.connections.find((connection) => connection.protocol === 'serial')
                          ?.id ?? '',
                    }),
                ...(event === 'data' ? { direction: 'rx' } : {}),
              })
            }
          >
            <Radio size={14} />
            <span>
              {zh
                ? ['串口插拔', '串口接收', '串口状态', '串口错误'][index]
                : ['Serial devices', 'Serial data', 'Serial state', 'Serial error'][index]}
            </span>
          </button>
        ))}
        <button
          disabled={!flow}
          onClick={() =>
            addNode('event', {
              trigger: 'controlledInterval',
              interval: { source: 'literal', value: 1000 },
              enabled: { source: 'literal', value: false },
            })
          }
        >
          <Clock3 size={14} />
          <span>{zh ? '受控定时器' : 'Controlled interval'}</span>
        </button>
      </div>
      <div className="qg-flow-workspace">
        <div className="qg-flow-canvas">
          {flow ? (
            <ReactFlow<QuickNode>
              key={flow.id}
              nodes={flow.nodes.map((node) => ({
                id: node.id,
                type: 'quickgui',
                position: node.position,
                initialWidth: 198,
                initialHeight: 76,
                measured: measurements[node.id],
                selected: selectedNodeId === node.id,
                data: { model: node, active: activeNodes.includes(node.id), locale },
              }))}
              edges={flow.edges.map((edge) => ({
                ...edge,
                selected: selectedEdgeId === edge.id,
                sourceHandle: edge.sourceHandle ?? 'output',
                targetHandle: edge.targetHandle ?? 'input',
                type: 'smoothstep',
                animated: activeNodes.includes(edge.source),
                style: {
                  stroke:
                    selectedEdgeId === edge.id
                      ? 'var(--accent, #a78bfa)'
                      : edge.sourceHandle === 'true'
                        ? '#34d399'
                        : edge.sourceHandle === 'false'
                          ? '#f87171'
                          : '#737985',
                  strokeWidth: selectedEdgeId === edge.id ? 2.8 : 1.8,
                },
              }))}
              nodeTypes={nodeTypes}
              onConnect={onConnect}
              isValidConnection={canConnect}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_event, node) => {
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
              }}
              onEdgeClick={(_event, edge) => {
                setSelectedEdgeId(edge.id);
                setSelectedNodeId(null);
              }}
              onPaneClick={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
              }}
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
              minZoom={0.25}
              maxZoom={1.5}
              connectionRadius={28}
              snapToGrid
              snapGrid={[16, 16]}
              colorMode={project.theme.mode}
              deleteKeyCode={['Backspace', 'Delete']}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="var(--border, #30343b)"
              />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) => nodeInfo[(node.data as QuickNode['data']).model.kind].color}
                style={{ width: 135, height: 85 }}
              />
            </ReactFlow>
          ) : (
            <div className="qg-inspector-empty">
              <GitBranch size={34} />
              <strong>{zh ? '创建第一个逻辑流程' : 'Create your first flow'}</strong>
              <button className="qg-primary-button" onClick={newFlow}>
                <Plus size={14} />
                {zh ? '新增流程' : 'New flow'}
              </button>
            </div>
          )}
        </div>
        <aside className="qg-flow-settings">
          {flow &&
            (selectedNode ? (
              <>
                <div className="qg-flow-settings-title">
                  <span>{zh ? '节点配置' : 'NODE SETTINGS'}</span>
                  <button
                    className="qg-icon-button danger"
                    onClick={deleteSelectedNode}
                    aria-label={zh ? '删除节点' : 'Delete node'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <Field label={zh ? '节点名称' : 'Node label'}>
                  <input
                    value={selectedNode.label}
                    onChange={(event) => updateNode({ label: event.target.value })}
                  />
                </Field>
                <div className="qg-id-display">
                  {nodeInfo[selectedNode.kind][zh ? 'zh' : 'en']}
                  <code>{selectedNode.id.slice(0, 8)}</code>
                </div>
                {selectedNode.kind === 'event' && (
                  <>
                    <Field label={zh ? '触发方式' : 'Trigger'}>
                      <select
                        value={String(selectedNode.config.trigger ?? 'manual')}
                        onChange={(event) => {
                          const trigger = event.target.value;
                          const config: Record<string, Json> =
                            trigger === 'serial'
                              ? { trigger, event: 'devices' }
                              : trigger === 'controlledInterval'
                                ? {
                                    trigger,
                                    interval: { source: 'literal', value: 1000 },
                                    enabled: { source: 'literal', value: false },
                                  }
                                : trigger === 'interval'
                                  ? { trigger, intervalMs: 1000 }
                                  : { trigger };
                          const apply = () => updateNode({ config });
                          if (
                            project.schemaVersion < 4 &&
                            ['serial', 'controlledInterval'].includes(trigger)
                          )
                            onRequestV4?.(apply);
                          else apply();
                        }}
                      >
                        <option value="manual">
                          {zh ? '手动 / UI 事件' : 'Manual / UI event'}
                        </option>
                        <option value="startup">{zh ? '运行时启动' : 'Runtime startup'}</option>
                        <option value="interval">{zh ? '定时触发' : 'Interval'}</option>
                        <option value="serial">
                          {zh ? '串口事件（v4）' : 'Serial event (v4)'}
                        </option>
                        <option value="controlledInterval">
                          {zh ? '受控定时（v4）' : 'Controlled interval (v4)'}
                        </option>
                      </select>
                    </Field>
                    {selectedNode.config.trigger === 'interval' && (
                      <Field label={zh ? '间隔（毫秒）' : 'Interval (ms)'}>
                        <NumberInput
                          value={Number(selectedNode.config.intervalMs ?? 1000)}
                          min={100}
                          onChange={(value) => updateConfig('intervalMs', value)}
                        />
                      </Field>
                    )}
                    {selectedNode.config.trigger === 'controlledInterval' && (
                      <>
                        <FlowValueRefEditor
                          label={zh ? '间隔（100–86400000 ms）' : 'Interval (100–86400000 ms)'}
                          project={project}
                          value={selectedNode.config.interval}
                          onChange={(value) => updateConfig('interval', value)}
                        />
                        <FlowValueRefEditor
                          label={zh ? '启用（布尔值）' : 'Enabled (boolean)'}
                          project={project}
                          value={selectedNode.config.enabled}
                          onChange={(value) => updateConfig('enabled', value)}
                        />
                        <p className="qg-field-hint">
                          {zh
                            ? '实时读取变量；错过的时刻不补发，忙碌时跳过，不累积发送。'
                            : 'Reads current variables. Missed or busy ticks are skipped; sends do not accumulate.'}
                        </p>
                      </>
                    )}
                    {selectedNode.config.trigger === 'serial' && (
                      <>
                        <Field label={zh ? '串口事件' : 'Serial event'}>
                          <select
                            value={String(selectedNode.config.event ?? 'devices')}
                            onChange={(event) => {
                              const kind = event.target.value;
                              updateNode({
                                config: {
                                  trigger: 'serial',
                                  event: kind,
                                  ...(kind === 'devices'
                                    ? {}
                                    : {
                                        connectionId:
                                          selectedNode.config.connectionId ??
                                          project.connections.find(
                                            (connection) => connection.protocol === 'serial',
                                          )?.id ??
                                          '',
                                      }),
                                  ...(kind === 'data' ? { direction: 'rx' } : {}),
                                },
                              });
                            }}
                          >
                            {['devices', 'data', 'state', 'error'].map((event, index) => (
                              <option key={event} value={event}>
                                {zh
                                  ? ['设备插拔与快照', '收发数据', '会话状态', '设备错误'][index]
                                  : event}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {selectedNode.config.event !== 'devices' && (
                          <Field label={zh ? '串口连接' : 'Serial connection'}>
                            <select
                              value={String(selectedNode.config.connectionId ?? '')}
                              onChange={(event) => updateConfig('connectionId', event.target.value)}
                            >
                              <option value="">
                                {zh ? '选择串口连接' : 'Choose serial connection'}
                              </option>
                              {project.connections
                                .filter((connection) => connection.protocol === 'serial')
                                .map((connection) => (
                                  <option key={connection.id} value={connection.id}>
                                    {connection.name}
                                  </option>
                                ))}
                            </select>
                          </Field>
                        )}
                        {selectedNode.config.event === 'data' && (
                          <Field label={zh ? '数据方向' : 'Data direction'}>
                            <select
                              value={String(selectedNode.config.direction ?? 'rx')}
                              onChange={(event) => updateConfig('direction', event.target.value)}
                            >
                              <option value="rx">RX</option>
                              <option value="tx">TX</option>
                              <option value="both">RX + TX</option>
                            </select>
                          </Field>
                        )}
                        <p className="qg-field-hint">
                          {zh
                            ? '仅原生串口事件触发。初始快照不是插入事件；手动运行不会伪造串口事件。'
                            : 'Triggered by native serial events. Initial snapshots are not insertions; manual runs do not fabricate events.'}
                        </p>
                      </>
                    )}
                    <p className="qg-field-hint">
                      {zh
                        ? '在 UI 组件的“事件与流程”中关联手动事件；启动与定时触发在运行时启动后执行。'
                        : 'Bind manual events in the component inspector. Startup and interval triggers execute after the runtime starts.'}
                    </p>
                  </>
                )}
                {selectedNode.kind === 'serial' && (
                  <>
                    <Field label={zh ? '串口操作' : 'Serial action'}>
                      <select
                        value={String(selectedNode.config.action ?? 'scan')}
                        onChange={(event) =>
                          updateNode({
                            config: createFlowNodeConfig(
                              'serial',
                              project,
                              event.target.value as SerialAction,
                            ),
                          })
                        }
                      >
                        {serialActions.map(([action, cn, en]) => (
                          <option key={action} value={action}>
                            {zh ? cn : en}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {!['scan', 'filter'].includes(String(selectedNode.config.action)) && (
                      <Field label={zh ? '串口连接' : 'Serial connection'}>
                        <select
                          value={String(selectedNode.config.connectionId ?? '')}
                          onChange={(event) => updateConfig('connectionId', event.target.value)}
                        >
                          <option value="">
                            {zh ? '选择串口连接' : 'Choose serial connection'}
                          </option>
                          {project.connections
                            .filter((connection) => connection.protocol === 'serial')
                            .map((connection) => (
                              <option key={connection.id} value={connection.id}>
                                {connection.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                    )}
                    {(selectedNode.config.action === 'filter'
                      ? [
                          ['ports', zh ? '端口数组' : 'Ports array'],
                          ['vid', 'VID'],
                          ['pid', 'PID'],
                        ]
                      : selectedNode.config.action === 'open'
                        ? [['settings', zh ? '打开参数' : 'Open settings']]
                        : selectedNode.config.action === 'setReconnect'
                          ? [['enabled', zh ? '自动重连' : 'Auto reconnect']]
                          : selectedNode.config.action === 'send'
                            ? [
                                ['data', zh ? '发送内容' : 'Send content'],
                                ['encoding', zh ? '编码 utf8 / hex' : 'Encoding utf8 / hex'],
                                [
                                  'lineEnding',
                                  zh ? '行尾 none / lf / crlf' : 'Line ending none / lf / crlf',
                                ],
                                ['timeoutMs', zh ? '超时（1–15000 ms）' : 'Timeout (1–15000 ms)'],
                              ]
                            : []
                    ).map(([key, label]) => (
                      <FlowValueRefEditor
                        key={`${selectedNode.id}:${key}`}
                        label={label}
                        value={selectedNode.config[key]}
                        project={project}
                        onChange={(value) => updateConfig(key, value)}
                      />
                    ))}
                    <p className="qg-field-hint">
                      {selectedNode.config.action === 'filter'
                        ? zh
                          ? '空值表示不限；VID/PID 支持整数或 1–4 位十六进制。两项同时匹配，未知标识不会匹配指定值。'
                          : 'Empty means unrestricted. IDs accept integers or 1–4 hex digits. Both must match; unknown IDs never match a specified filter.'
                        : zh
                          ? '需要桌面原生运行时。success 为成功结果，error 为结构化错误；打开及发送必须由显式流程触发。'
                          : 'Requires the native desktop runtime. success returns a result; error returns a structured diagnostic. Open and send require explicit flows.'}
                    </p>
                  </>
                )}
                {selectedNode.kind === 'map' && (
                  <>
                    <Field label={zh ? '映射方式' : 'Mapping operation'}>
                      <select
                        value={String(selectedNode.config.operation ?? 'value')}
                        onChange={(event) => {
                          const operation = event.target.value;
                          updateNode({
                            config:
                              operation === 'value'
                                ? { operation, value: { source: 'input', path: [] } }
                                : operation === 'object'
                                  ? { operation, fields: {} }
                                  : { operation, items: { source: 'input', path: [] }, fields: {} },
                          });
                        }}
                      >
                        <option value="value">{zh ? '提取值' : 'Extract value'}</option>
                        <option value="object">{zh ? '构造对象' : 'Build object'}</option>
                        <option value="array">{zh ? '逐项映射数组' : 'Map array items'}</option>
                      </select>
                    </Field>
                    {selectedNode.config.operation === 'value' ? (
                      <FlowValueRefEditor
                        label={zh ? '输出值' : 'Output value'}
                        value={selectedNode.config.value}
                        project={project}
                        onChange={(value) => updateConfig('value', value)}
                      />
                    ) : (
                      <>
                        {selectedNode.config.operation === 'array' && (
                          <FlowValueRefEditor
                            label={zh ? '输入数组' : 'Input array'}
                            value={selectedNode.config.items}
                            project={project}
                            onChange={(value) => updateConfig('items', value)}
                          />
                        )}
                        <FlowMapFieldsEditor
                          fields={selectedNode.config.fields}
                          project={project}
                          onChange={(value) => updateConfig('fields', value)}
                        />
                      </>
                    )}
                  </>
                )}
                {selectedNode.kind === 'append' && (
                  <>
                    <Field label={zh ? 'JSON 变量' : 'JSON variable'}>
                      <select
                        value={String(selectedNode.config.variable ?? '')}
                        onChange={(event) => updateConfig('variable', event.target.value)}
                      >
                        <option value="">{zh ? '选择变量' : 'Choose variable'}</option>
                        {project.variables
                          .filter((variable) => variable.type === 'json')
                          .map((variable) => (
                            <option key={variable.id} value={variable.id}>
                              {variable.name}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Field label={zh ? '数组路径' : 'Array path'}>
                      <JsonValueField
                        label={zh ? '数组路径' : 'Array path'}
                        value={selectedNode.config.path ?? []}
                        onCommit={(value) => {
                          assertJsonPath(value as JsonPath);
                          updateConfig('path', value);
                        }}
                      />
                    </Field>
                    <FlowValueRefEditor
                      label={zh ? '追加记录' : 'Item to append'}
                      value={selectedNode.config.item}
                      project={project}
                      onChange={(value) => updateConfig('item', value)}
                    />
                    <Field label={zh ? '最多条数' : 'Maximum records'}>
                      <NumberInput
                        value={Number(selectedNode.config.maxItems ?? 500)}
                        min={1}
                        onChange={(value) => updateConfig('maxItems', Math.round(value))}
                      />
                    </Field>
                    <Field label={zh ? '最多字节' : 'Maximum bytes'}>
                      <NumberInput
                        value={Number(selectedNode.config.maxBytes ?? 524288)}
                        min={1}
                        max={1048576}
                        onChange={(value) => updateConfig('maxBytes', Math.round(value))}
                      />
                    </Field>
                    <Field label={zh ? '显示顺序' : 'Display order'}>
                      <select
                        value={String(selectedNode.config.order ?? 'oldestFirst')}
                        onChange={(event) => updateConfig('order', event.target.value)}
                      >
                        <option value="oldestFirst">{zh ? '旧记录在前' : 'Oldest first'}</option>
                        <option value="latestFirst">{zh ? '新记录在前' : 'Latest first'}</option>
                      </select>
                    </Field>
                    <Toggle
                      label={zh ? '累计淘汰条数' : 'Count evicted records'}
                      value={selectedNode.config.droppedPath !== undefined}
                      onChange={(enabled) => {
                        const config = { ...selectedNode.config };
                        if (enabled) config.droppedPath = ['dropped'];
                        else delete config.droppedPath;
                        updateNode({ config });
                      }}
                    />
                    {selectedNode.config.droppedPath !== undefined && (
                      <Field label={zh ? '同变量内计数路径' : 'Counter path in the same variable'}>
                        <JsonValueField
                          label={zh ? '淘汰计数路径' : 'Eviction counter path'}
                          value={selectedNode.config.droppedPath}
                          onCommit={(value) => {
                            assertJsonPath(value as JsonPath);
                            updateConfig('droppedPath', value);
                          }}
                        />
                      </Field>
                    )}
                    <p className="qg-field-hint">
                      {zh
                        ? '追加及淘汰计数原子更新；单条超过容量时拒绝追加。显示历史淘汰不同于未处理接收队列过载。'
                        : 'Append and eviction counts update atomically. Oversized items are rejected. Display history eviction is distinct from RX queue overload.'}
                    </p>
                  </>
                )}
                {(selectedNode.kind === 'read' || selectedNode.kind === 'write') && (
                  <Field label={zh ? '变量' : 'Variable'}>
                    <select
                      value={String(selectedNode.config.variable ?? '')}
                      onChange={(event) => updateConfig('variable', event.target.value)}
                    >
                      <option value="">{zh ? '选择变量' : 'Select variable'}</option>
                      {project.variables.map((variable) => (
                        <option key={variable.id} value={variable.id}>
                          {variable.name} · {variable.type}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {selectedNode.kind === 'write' && (
                  <>
                    <Toggle
                      label={zh ? '使用上游输入值' : 'Use incoming value'}
                      value={selectedNode.config.value === undefined}
                      onChange={(value) => {
                        const config = { ...selectedNode.config };
                        if (value) delete config.value;
                        else config.value = 0;
                        updateNode({ config });
                      }}
                    />
                    {selectedNode.config.value !== undefined && (
                      <Field label={zh ? '固定值' : 'Fixed value'}>
                        <input
                          value={
                            typeof selectedNode.config.value === 'object'
                              ? JSON.stringify(selectedNode.config.value)
                              : String(selectedNode.config.value)
                          }
                          onChange={(event) => {
                            let value: Json = event.target.value;
                            try {
                              value = JSON.parse(event.target.value);
                            } catch {
                              /* Text is also a supported value. */
                            }
                            updateConfig('value', value);
                          }}
                        />
                      </Field>
                    )}
                  </>
                )}
                {selectedNode.kind === 'math' && (
                  <>
                    <Field label={zh ? '运算' : 'Operation'}>
                      <select
                        value={String(selectedNode.config.operation ?? 'add')}
                        onChange={(event) => updateConfig('operation', event.target.value)}
                      >
                        {[
                          ['add', '+ 加'],
                          ['subtract', '− 减'],
                          ['multiply', '× 乘'],
                          ['divide', '÷ 除'],
                        ].map(([key, label]) => (
                          <option key={key} value={key}>
                            {zh ? label : key}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={zh ? '操作数' : 'Operand'}>
                      <NumberInput
                        value={Number(selectedNode.config.operand ?? 1)}
                        onChange={(value) => updateConfig('operand', value)}
                      />
                    </Field>
                  </>
                )}
                {(selectedNode.kind === 'read' || selectedNode.kind === 'write') && (
                  <Field
                    label={zh ? 'JSON 字段路径' : 'JSON field path'}
                    hint={
                      zh
                        ? '例如 ["data",0,"value"]；[] 表示整个变量，仅访问已有字段。'
                        : 'For example ["data",0,"value"]. [] addresses the whole value; only existing fields are accessed.'
                    }
                  >
                    <JsonValueField
                      key={selectedNode.id}
                      label={zh ? 'JSON 字段路径' : 'JSON field path'}
                      value={selectedNode.config.path ?? []}
                      onCommit={(value) => {
                        if (!Array.isArray(value))
                          throw new Error(zh ? '路径必须是数组' : 'Path must be an array');
                        assertJsonPath(value as JsonPath);
                        const apply = () => updateConfig('path', value);
                        if (project.schemaVersion < 3) onRequestUpgrade?.(apply);
                        else apply();
                      }}
                    />
                  </Field>
                )}
                {selectedNode.kind === 'condition' && (
                  <>
                    <Field label={zh ? '比较运算符' : 'Comparison'}>
                      <select
                        value={String(selectedNode.config.operator ?? 'gt')}
                        onChange={(event) => updateConfig('operator', event.target.value)}
                      >
                        {[
                          ['gt', '>'],
                          ['gte', '≥'],
                          ['lt', '<'],
                          ['lte', '≤'],
                          ['eq', '='],
                          ['neq', '≠'],
                        ].map(([key, label]) => (
                          <option key={key} value={key}>
                            {label} {key}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={zh ? '比较值' : 'Compare value'}>
                      <input
                        value={String(selectedNode.config.value ?? 0)}
                        onChange={(event) =>
                          updateConfig(
                            'value',
                            event.target.value.trim() !== '' &&
                              Number.isFinite(Number(event.target.value))
                              ? Number(event.target.value)
                              : event.target.value,
                          )
                        }
                      />
                    </Field>
                    <p className="qg-field-hint">
                      {zh
                        ? '绿色出口为 true，红色出口为 false。'
                        : 'Green output is true; red output is false.'}
                    </p>
                  </>
                )}
                {selectedNode.kind === 'delay' && (
                  <Field label={zh ? '延时（毫秒）' : 'Delay (ms)'}>
                    <NumberInput
                      value={Number(selectedNode.config.ms ?? 250)}
                      min={0}
                      max={60000}
                      onChange={(value) => updateConfig('ms', value)}
                    />
                  </Field>
                )}
                {selectedNode.kind === 'log' && (
                  <Field label={zh ? '日志消息' : 'Log message'}>
                    <textarea
                      rows={4}
                      value={String(selectedNode.config.message ?? '')}
                      onChange={(event) => updateConfig('message', event.target.value)}
                    />
                  </Field>
                )}
                {selectedNode.kind === 'script' && (
                  <Field label={zh ? 'C 脚本插件' : 'C script plugin'}>
                    <select
                      value={String(selectedNode.config.scriptId ?? '')}
                      onChange={(event) => updateConfig('scriptId', event.target.value)}
                    >
                      <option value="">{zh ? '选择脚本' : 'Choose script'}</option>
                      {project.scripts.map((script) => (
                        <option key={script.id} value={script.id}>
                          {script.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {selectedNode.kind === 'http' && (
                  <>
                    <Field label="URL">
                      <input
                        placeholder="https://api.example.com/value"
                        value={String(selectedNode.config.url ?? '')}
                        onChange={(event) => updateConfig('url', event.target.value)}
                      />
                    </Field>
                    <Field label={zh ? '方法' : 'Method'}>
                      <select
                        value={String(selectedNode.config.method ?? 'GET')}
                        onChange={(event) => updateConfig('method', event.target.value)}
                      >
                        {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                          <option key={method}>{method}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label={zh ? '请求正文' : 'Request body'}>
                      <textarea
                        rows={4}
                        value={String(selectedNode.config.body ?? '')}
                        onChange={(event) => updateConfig('body', event.target.value)}
                      />
                    </Field>
                  </>
                )}
                {selectedNode.kind === 'emit' && (
                  <Field label={zh ? '事件名称' : 'Event name'}>
                    <input
                      value={String(selectedNode.config.event ?? '')}
                      onChange={(event) => updateConfig('event', event.target.value)}
                    />
                  </Field>
                )}
                {selectedNode.kind === 'window' && (
                  <>
                    <Field label={zh ? '目标窗口' : 'Target window'}>
                      <select
                        value={String(selectedNode.config.windowId ?? 'main')}
                        onChange={(event) =>
                          updateNode({
                            config: {
                              ...selectedNode.config,
                              windowId: event.target.value,
                              action:
                                event.target.value === 'main' &&
                                selectedNode.config.action === 'close'
                                  ? 'open'
                                  : selectedNode.config.action,
                            },
                          })
                        }
                      >
                        {listProjectWindows(project).map((window) => (
                          <option key={window.id} value={window.id}>
                            {window.name}
                            {window.id === 'main' ? (zh ? '（主窗口）' : ' (main)') : ''}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={zh ? '窗口操作' : 'Window action'}>
                      <select
                        value={String(selectedNode.config.action ?? 'open')}
                        onChange={(event) => updateConfig('action', event.target.value)}
                      >
                        <option value="open">{zh ? '打开窗口' : 'Open window'}</option>
                        <option value="focus">{zh ? '聚焦窗口' : 'Focus window'}</option>
                        <option value="close" disabled={selectedNode.config.windowId === 'main'}>
                          {zh ? '关闭子窗口' : 'Close secondary window'}
                        </option>
                      </select>
                    </Field>
                    <p className="qg-field-hint">
                      {zh
                        ? '所有窗口共享变量和流程。打开或聚焦已存在的窗口会复用原窗口；关闭子窗口不会停止共享流程。'
                        : 'Windows share variables and flows. Open/focus reuses the existing window. Closing a secondary window keeps shared flows running.'}
                    </p>
                  </>
                )}
                {selectedNode.kind === 'connection' && (
                  <>
                    <Field label={zh ? '设备或服务连接' : 'Device or service connection'}>
                      <select
                        value={String(selectedNode.config.connectionId ?? '')}
                        onChange={(event) => updateConfig('connectionId', event.target.value)}
                      >
                        <option value="">{zh ? '选择连接' : 'Select connection'}</option>
                        {project.connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name} · {connection.protocol.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <p className="qg-field-hint">
                      {zh
                        ? '连接配置在“连接”工作区维护。HTTP、WebSocket、MQTT、串口和 TCP 请求由运行时驱动执行。'
                        : 'Manage connection settings in Connections. Runtime drivers execute HTTP, WebSocket, MQTT, serial and TCP requests.'}
                    </p>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="qg-flow-settings-title">{zh ? '流程设置' : 'FLOW SETTINGS'}</div>
                <Field label={zh ? '流程名称' : 'Flow name'}>
                  <input
                    value={flow.name}
                    onChange={(event) => updateFlow({ name: event.target.value })}
                  />
                </Field>
                <Toggle
                  label={zh ? '启用流程' : 'Enable flow'}
                  value={flow.enabled}
                  onChange={(enabled) => updateFlow({ enabled })}
                />
                <p className="qg-field-hint">
                  {zh
                    ? '点击上方节点类型添加节点。拖动节点端口建立连接。选中节点后按 Delete 删除。'
                    : 'Add a node using the toolbar. Drag between ports to connect nodes. Press Delete to remove selected nodes.'}
                </p>
                <div className="qg-flow-stats">
                  <div>
                    <strong>{flow.nodes.length}</strong>
                    <span>{zh ? '节点' : 'nodes'}</span>
                  </div>
                  <div>
                    <strong>{flow.edges.length}</strong>
                    <span>{zh ? '连线' : 'connections'}</span>
                  </div>
                </div>
                <button
                  className="qg-secondary-button qg-danger-button"
                  onClick={() => {
                    onChange(project.flows.filter((item) => item.id !== flow.id));
                    setSelectedNodeId(null);
                  }}
                >
                  {zh ? '删除此流程' : 'Delete this flow'}
                </button>
              </>
            ))}
        </aside>
      </div>
    </div>
  );
}

export default FlowEditor;
