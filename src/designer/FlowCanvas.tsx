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
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import type { Flow, FlowNode, Locale, ThemeMode } from '../core/types';

export type QuickFlowNode = Node<{ model: FlowNode; active: boolean; locale: Locale }, 'quickgui'>;
export const FlowActivityContext = createContext<readonly string[]>([]);

interface FlowCanvasProps {
  flow: Flow;
  nodes: QuickFlowNode[];
  edges: Edge[];
  nodeTypes: NodeTypes;
  colorMode: ThemeMode;
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

/** Keep pointer-rate updates inside the graph, away from the project and property forms. */
export const FlowCanvas = memo(function FlowCanvas({
  flow,
  nodes,
  edges,
  nodeTypes,
  colorMode,
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
      snapToGrid
      snapGrid={snapGrid}
      colorMode={colorMode}
      deleteKeyCode={deleteKeys}
      proOptions={proOptions}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={20}
        size={1}
        color="var(--border, #30343b)"
      />
      <Controls showInteractive={false} />
      <MiniMap<QuickFlowNode> pannable zoomable nodeColor={nodeColor} style={minimapStyle} />
    </ReactFlow>
  );
});
