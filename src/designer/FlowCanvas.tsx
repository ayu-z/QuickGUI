import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import { ChevronRight, GitBranch, Grid3X3, Magnet, Maximize, Minus, Plus } from 'lucide-react';
import type { Flow, FlowNode, Locale, ThemeMode } from '../core/types';

export type QuickFlowNode = Node<{ model: FlowNode; active: boolean; locale: Locale }, 'quickgui'>;
export const FlowActivityContext = createContext<readonly string[]>([]);

interface FlowCanvasProps {
  flow: Flow;
  nodes: QuickFlowNode[];
  edges: Edge[];
  nodeTypes: NodeTypes;
  colorMode: ThemeMode;
  locale: Locale;
  selectedLabel?: string;
  onInit: (instance: ReactFlowInstance<QuickFlowNode>) => void;
  onNodesChange: (changes: NodeChange<QuickFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  isValidConnection: (connection: Connection | Edge) => boolean;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClearSelection: () => void;
  nodeColor: (node: QuickFlowNode) => string;
}

type DraftPosition = { position: FlowNode['position']; dragging?: boolean };
type PositionDraft = {
  flow: Flow;
  positions: Map<string, DraftPosition>;
};

const snapGrid: [number, number] = [16, 16];
const fitViewOptions = { padding: 0.3, maxZoom: 1 };
const proOptions = { hideAttribution: true };
const deleteKeys = ['Backspace', 'Delete'];
const minimapStyle = { width: 135, height: 85 };

const FlowCanvasHeading = memo(function FlowCanvasHeading({
  flow,
  locale,
  grid,
  snap,
  onToggleGrid,
  onToggleSnap,
}: {
  flow: Flow;
  locale: Locale;
  grid: boolean;
  snap: boolean;
  onToggleGrid: () => void;
  onToggleSnap: () => void;
}) {
  const zh = locale === 'zh-CN';
  const { zoom } = useViewport();
  const { zoomTo, fitView } = useReactFlow<QuickFlowNode>();
  return (
    <div className="canvas-heading qg-flow-heading">
      <div className="canvas-heading-context">
        <span>{zh ? '流程' : 'FLOW'}</span>
        <ChevronRight size={12} />
        <strong title={flow.name}>{flow.name}</strong>
      </div>
      <div
        className="canvas-heading-tools"
        role="toolbar"
        aria-label={zh ? '流程画布工具' : 'Flow canvas tools'}
      >
        <span className="dimension-label">
          <GitBranch size={14} />
          {flow.nodes.length} {zh ? '节点' : 'nodes'} · {flow.edges.length} {zh ? '连线' : 'edges'}
        </span>
        <div className="qg-toolbar-cluster">
          <button
            className={`qg-icon-button ${grid ? 'active' : ''}`}
            onClick={onToggleGrid}
            aria-label={zh ? '切换网格' : 'Toggle grid'}
            aria-pressed={grid}
            title={zh ? '网格' : 'Grid'}
          >
            <Grid3X3 size={15} />
          </button>
          <button
            className={`qg-icon-button ${snap ? 'active' : ''}`}
            onClick={onToggleSnap}
            aria-label={zh ? '切换吸附' : 'Toggle snap'}
            aria-pressed={snap}
            title={zh ? '吸附网格（16px）' : 'Snap to grid (16px)'}
          >
            <Magnet size={15} />
          </button>
          <span className="qg-toolbar-divider" />
          <button
            className="qg-icon-button"
            aria-label={zh ? '缩小' : 'Zoom out'}
            onClick={() => void zoomTo(Math.max(0.1, zoom - 0.1))}
          >
            <Minus size={14} />
          </button>
          <button
            className="qg-zoom-value"
            aria-label={zh ? '重置缩放' : 'Reset zoom'}
            title={zh ? '重置为100%' : 'Reset to 100%'}
            onClick={() => void zoomTo(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="qg-icon-button"
            aria-label={zh ? '放大' : 'Zoom in'}
            onClick={() => void zoomTo(Math.min(1.5, zoom + 0.1))}
          >
            <Plus size={14} />
          </button>
          <button
            className="qg-icon-button"
            aria-label={zh ? '适应画布' : 'Fit canvas'}
            title={zh ? '适应画布' : 'Fit canvas'}
            onClick={() => void fitView(fitViewOptions)}
          >
            <Maximize size={14} />
          </button>
        </div>
      </div>
    </div>
  );
});

/** Keep pointer-rate updates inside the graph, away from the project and property forms. */
export const FlowCanvas = memo(function FlowCanvas({
  flow,
  nodes,
  edges,
  nodeTypes,
  colorMode,
  locale,
  selectedLabel,
  onInit,
  onNodesChange,
  onEdgesChange,
  onConnect,
  isValidConnection,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  nodeColor,
}: FlowCanvasProps) {
  const [draft, setDraft] = useState<PositionDraft | null>(null);
  const [grid, setGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const toggleGrid = useCallback(() => setGrid((value) => !value), []);
  const toggleSnap = useCallback(() => setSnap((value) => !value), []);
  const pending = useRef<PositionDraft | null>(null);
  const frame = useRef<number | null>(null);
  const activeNodes = useContext(FlowActivityContext);
  const activeSet = useMemo(() => new Set(activeNodes), [activeNodes]);
  const nodeViews = useRef(new Map<string, { base: QuickFlowNode; view: QuickFlowNode }>());
  const edgeViews = useRef(new Map<string, { base: Edge; view: Edge }>());
  const previousNodes = useRef<QuickFlowNode[]>([]);
  const previousEdges = useRef<Edge[]>([]);

  useLayoutEffect(() => {
    pending.current = null;
    setDraft(null);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [flow]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<QuickFlowNode>[]) => {
      const positions = changes.filter((change) => change.type === 'position' && change.position);
      if (positions.length) {
        const next =
          pending.current?.flow === flow
            ? pending.current
            : { flow, positions: new Map<string, DraftPosition>() };
        for (const change of positions)
          if (change.type === 'position' && change.position)
            next.positions.set(change.id, {
              position: change.position,
              dragging: change.dragging,
            });
        pending.current = next;
        const flush = () => {
          frame.current = null;
          if (pending.current?.flow === flow)
            setDraft({ flow, positions: new Map(pending.current.positions) });
        };
        if (positions.some((change) => change.type === 'position' && change.dragging !== true)) {
          if (frame.current !== null) cancelAnimationFrame(frame.current);
          flush();
        } else if (frame.current === null) frame.current = requestAnimationFrame(flush);
      }
      // The owner records draft coordinates in a ref and commits once on release.
      onNodesChange(changes);
    },
    [flow, onNodesChange],
  );

  const liveNodes = useMemo(() => {
    const nextViews = new Map<string, { base: QuickFlowNode; view: QuickFlowNode }>();
    const views = nodes.map((node) => {
      const position = draft?.flow === flow ? draft.positions.get(node.id) : undefined;
      const active = activeSet.has(node.id);
      const previous = nodeViews.current.get(node.id);
      let view: QuickFlowNode;
      if (
        previous?.base === node &&
        previous.view.position === (position?.position ?? node.position) &&
        previous.view.dragging === position?.dragging &&
        previous.view.data.active === active
      )
        view = previous.view;
      else {
        const previousData = previous?.view.data;
        const data =
          previousData?.model === node.data.model &&
          previousData.locale === node.data.locale &&
          previousData.active === active
            ? previousData
            : active === node.data.active
              ? node.data
              : { ...node.data, active };
        view = !position && data === node.data ? node : { ...node, ...position, data };
      }
      nextViews.set(node.id, { base: node, view });
      return view;
    });
    nodeViews.current = nextViews;
    if (
      views.length !== previousNodes.current.length ||
      views.some((node, index) => node !== previousNodes.current[index])
    )
      previousNodes.current = views;
    return previousNodes.current;
  }, [flow, nodes, draft, activeSet]);
  const liveEdges = useMemo(() => {
    const nextViews = new Map<string, { base: Edge; view: Edge }>();
    const views = edges.map((edge) => {
      const animated = edge.data?.execution === true && activeSet.has(edge.source);
      const previous = edgeViews.current.get(edge.id);
      const view =
        previous?.base === edge && previous.view.animated === animated
          ? previous.view
          : edge.animated === animated
            ? edge
            : { ...edge, animated };
      nextViews.set(edge.id, { base: edge, view });
      return view;
    });
    edgeViews.current = nextViews;
    if (
      views.length !== previousEdges.current.length ||
      views.some((edge, index) => edge !== previousEdges.current[index])
    )
      previousEdges.current = views;
    return previousEdges.current;
  }, [edges, activeSet]);
  const selectNode = useCallback(
    (_event: React.MouseEvent, node: QuickFlowNode) => onSelectNode(node.id),
    [onSelectNode],
  );
  const selectEdge = useCallback(
    (_event: React.MouseEvent, edge: Edge) => onSelectEdge(edge.id),
    [onSelectEdge],
  );

  return (
    <ReactFlowProvider
      initialNodes={nodes}
      initialEdges={edges}
      initialMinZoom={0.1}
      initialMaxZoom={1.5}
      fitView
      initialFitViewOptions={fitViewOptions}
    >
      <div className="qg-flow-stage">
        <FlowCanvasHeading
          flow={flow}
          locale={locale}
          grid={grid}
          snap={snap}
          onToggleGrid={toggleGrid}
          onToggleSnap={toggleSnap}
        />
        <div className="qg-flow-viewport">
          <ReactFlow<QuickFlowNode>
            key={flow.id}
            onInit={onInit}
            nodes={liveNodes}
            edges={liveEdges}
            nodeTypes={nodeTypes}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={selectNode}
            onEdgeClick={selectEdge}
            onPaneClick={onClearSelection}
            fitView
            fitViewOptions={fitViewOptions}
            minZoom={0.1}
            maxZoom={1.5}
            connectionRadius={28}
            snapToGrid={snap}
            snapGrid={snapGrid}
            colorMode={colorMode}
            deleteKeyCode={deleteKeys}
            proOptions={proOptions}
          >
            {grid && (
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="var(--border, #30343b)"
              />
            )}
            <MiniMap<QuickFlowNode> pannable zoomable nodeColor={nodeColor} style={minimapStyle} />
          </ReactFlow>
        </div>
        <div className="qg-canvas-status">
          <span>
            <i className="qg-status-dot" />
            {locale === 'zh-CN' ? '流程画布' : 'Flow canvas'}
          </span>
          <span title={selectedLabel ?? flow.name}>{selectedLabel ?? flow.name}</span>
          <span className="qg-flow-caption">
            {locale === 'zh-CN'
              ? '实线执行 · 虚线数据 · 命名端口'
              : 'Solid execution · Dashed data · Named ports'}
          </span>
        </div>
      </div>
    </ReactFlowProvider>
  );
});
