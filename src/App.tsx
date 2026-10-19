import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Box,
  ChevronDown,
  ChevronRight,
  CircuitBoard,
  Code2,
  Copy,
  Download,
  FilePlus2,
  FilePenLine,
  FolderOpen,
  GitBranch,
  Image,
  Layers,
  LayoutDashboard,
  Maximize2,
  Monitor,
  Moon,
  Palette,
  PanelLeftClose,
  Play,
  Plus,
  Radio,
  RotateCcw,
  RotateCw,
  Save,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  Trash2,
  X,
  Check,
  AlertCircle,
  Languages,
  ArrowUpRight,
  Activity,
  Package,
  Puzzle,
  Search,
  CircleDot,
} from 'lucide-react';
import { EditorStore, type EditorState, type Section } from './core/store';
import { manualFlowEntries, reconcileFlowBinding } from './core/flowBindings';
import { FlowBindingSelect } from './designer/FlowBindingSelect';
import {
  cloneSubtree,
  createEmptyProject,
  createProject,
  createWidget,
  defaultCScript,
  subtreeIds,
  uid,
  widgetNames,
} from './core/project';
import { download, exportProject, importProject, projectFilename } from './core/archive';
import { errorText, validateProject } from './core/validation';
import { translations } from './core/i18n';
import type {
  Flow,
  Json,
  Project,
  Widget,
  ComponentModule,
  Variable,
  Connection,
  RuntimeLog,
} from './core/types';
import { CanvasEditor } from './designer/CanvasEditor';
import { LayerTree } from './designer/LayerTree';
import {
  arrangementPatches,
  commandForKey,
  inheritedFlag,
  isEditingText,
  reorderedWidgets,
  selectionRoots,
  type DesignerCommand,
  type Point,
  type WidgetPatch,
} from './designer/commands';
import { Inspector } from './designer/Inspector';
import { Library } from './designer/Library';
import { WindowInspector } from './designer/WindowInspector';
import { FlowEditor } from './designer/FlowEditor';
import { CodeEditor } from './designer/CodeEditor';
import { RuntimeApp } from './runtime/RuntimeApp';
import { createRuntime } from './runtime/controller';
import { RuntimeController } from './runtime/engine';
import { RuntimeWindows } from './runtime/RuntimeWindows';
import { getProjectWindow, listProjectWindows, projectForWindow } from './core/windows';
import * as native from './native/bridge';
import './designer/designer.css';
import { ConnectionsPanel } from './panels/ConnectionsPanel';
import { AppearancePanel } from './panels/AppearancePanel';
import { TranslationsPanel } from './panels/TranslationsPanel';
import { HistoryPanel } from './panels/HistoryPanel';
import { importComponentPackage, exportComponentPackage } from './core/componentPackage';
import { WelcomeScreen } from './panels/WelcomeScreen';
import { ProjectNameDialog } from './panels/ProjectNameDialog';
import { WindowManager } from './panels/WindowManager';
import { PasteReviewDialog } from './panels/PasteReviewDialog';
import { JsonValueField } from './panels/JsonValueField';
import {
  copySelection,
  writeClipboard,
  readClipboard,
  preparePaste,
  applyPastePlan,
  type ClipboardBundle,
  type PastePlan,
  type EditScope,
} from './core/clipboard';
import { assertJsonValue } from './core/jsonValue';
import { variableReferences } from './core/references';
import { getWidgetDefinition, getBindableProperties, getJsonPath } from './core/widgetDefinitions';
import { useDismissibleLayer } from './hooks/useDismissibleLayer';
import { isAutomaticEventSource } from './core/flowV4';

function PreviewWindow() {
  const windowId = new URLSearchParams(location.search).get('windowId') ?? 'main';
  const [project, setProject] = useState<Project>();
  const [error, setError] = useState('');
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    let updates = 0;
    void (async () => {
      const unlisten = await native.onProjectUpdated((p) => {
        updates++;
        if (!cancelled) setProject(p);
      });
      if (cancelled) {
        unlisten();
        return;
      }
      dispose = unlisten;
      const before = updates;
      const initial = await native.getPreviewProject();
      if (!cancelled && before === updates) setProject(initial);
    })().catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  const [engine, setEngine] = useState<RuntimeController>();
  useEffect(() => {
    if (project && !engine) setEngine(createRuntime(project, { attachOnly: windowId !== 'main' }));
  }, [project, engine, windowId]);
  useEffect(() => () => engine?.dispose(), [engine]);
  return project && engine ? (
    <RuntimeApp project={project} engine={engine} windowId={windowId} />
  ) : (
    <div className="loading-screen">{error || 'Loading preview…'}</div>
  );
}

export default function App() {
  if (new URLSearchParams(location.search).has('preview')) return <PreviewWindow />;
  return <DesignerApp />;
}

function DesignerApp() {
  const [store] = useState(() => new EditorStore());
  const [designerTheme, setDesignerTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('quickgui.theme') === 'light' ? 'light' : 'dark',
  );
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => {
    document.documentElement.dataset.theme = designerTheme;
    localStorage.setItem('quickgui.theme', designerTheme);
    if (native.isDesktop())
      void native.setDesignerTheme(designerTheme).catch((error) => {
        console.error('Failed to synchronize the native title bar theme:', error);
      });
  }, [designerTheme]);
  return state.project ? (
    <ProjectWorkspace
      key={state.sessionId}
      store={store}
      state={{ ...state, project: state.project }}
      designerTheme={designerTheme}
      onToggleTheme={() => setDesignerTheme((theme) => (theme === 'dark' ? 'light' : 'dark'))}
    />
  ) : (
    <WelcomeScreen store={store} state={state} />
  );
}

function ProjectWorkspace({
  store,
  state,
  designerTheme,
  onToggleTheme,
  onCopy,
  onCut,
  onPaste,
}: {
  store: EditorStore;
  state: EditorState & { project: Project };
  designerTheme: 'light' | 'dark';
  onToggleTheme: () => void;
  onCopy?: (
    project: Project,
    scope: { kind: 'window' | 'module'; id: string },
    ids: string[],
  ) => void | Promise<void>;
  onCut?: (
    project: Project,
    scope: { kind: 'window' | 'module'; id: string },
    ids: string[],
  ) => void | Promise<void>;
  onPaste?: (
    project: Project,
    scope: { kind: 'window' | 'module'; id: string },
    point?: Point,
  ) => void | Promise<void>;
}) {
  const { project, section, selectedId, selectedIds, drafts, activeWindowId } = state;
  const [engine] = useState(() => createRuntime(project));
  const updateFlows = useCallback(
    (flows: Flow[]) => {
      store.update((p) => {
        const previous = p.flows;
        p.flows = flows;
        if (flows.some((flow) => flow.nodes.some((node) => node.kind === 'window'))) {
          p.windows ??= [];
        }
        for (const w of [
          ...listProjectWindows(p).flatMap((window) => window.widgets),
          ...p.modules.flatMap((m) => m.widgets),
        ])
          w.events = Object.fromEntries(
            Object.entries(w.events).flatMap(([event, binding]) => {
              const next = reconcileFlowBinding(binding, previous, flows);
              return next === undefined ? [] : [[event, next]];
            }),
          );
      });
    },
    [store],
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      engine.dispose();
    };
  }, [engine]);
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [leftTab, setLeftTab] = useState<'layers' | 'library' | 'modules' | 'assets'>('layers');
  const clipboardSession = useRef(crypto.randomUUID());
  const [pasteReview, setPasteReview] = useState<{
    bundle: ClipboardBundle;
    scope: EditScope;
    point?: Point;
  } | null>(null);
  const [nameAction, setNameAction] = useState<'create' | 'rename' | null>(null);
  const [preview, setPreview] = useState(false),
    [exportMenu, setExportMenu] = useState(false),
    [projectMenu, setProjectMenu] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null),
    exportMenuRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer(projectMenu, projectMenuRef, () => setProjectMenu(false));
  useDismissibleLayer(exportMenu, exportMenuRef, () => setExportMenu(false));
  const previewQueue = useRef<Promise<void>>(Promise.resolve());
  const previewGeneration = useRef(0);
  const [buildProgress, setBuildProgress] = useState<string | null>(null);
  const [buildLogs, setBuildLogs] = useState<RuntimeLog[]>([]);
  const buildInProgress = useRef(false);
  const consoleContent = useRef<HTMLDivElement>(null);
  const [runEntryKey, setRunEntryKey] = useState('');
  const followConsole = useRef(true);
  const consoleLogs = [...snapshot.logs, ...buildLogs].sort((a, b) => a.time - b.time).slice(-1000);
  const [showConsole, setShowConsole] = useState(true),
    [simulate, setSimulate] = useState(false);
  const resourceSection = section === 'appearance' || section === 'languages';
  const workspaceConsoleVisible = showConsole && (!resourceSection || buildProgress !== null);
  useEffect(() => {
    if (followConsole.current && consoleContent.current)
      consoleContent.current.scrollTop = consoleContent.current.scrollHeight;
  }, [snapshot.logs, buildLogs, workspaceConsoleVisible]);
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [pendingModule, setPendingModule] = useState<ComponentModule | null>(null);
  const [pendingProject, setPendingProject] = useState<Project | null>(null);
  const [closeRequest, setCloseRequest] = useState<{ next?: Project } | null>(null);
  const [closeError, setCloseError] = useState('');
  const [closeBusy, setCloseBusy] = useState(false);
  const closeInProgress = useRef(false);
  const componentInput = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const fileInput = useRef<HTMLInputElement>(null),
    assetInput = useRef<HTMLInputElement>(null);
  const t = translations[project.locale],
    zh = project.locale === 'zh-CN';
  const simulationAvailable = project.variables.some(
    (variable) =>
      ['temperature', 'pressure'].includes(variable.id) &&
      variable.type === 'number' &&
      !variable.readOnly,
  );
  const activeModule = project.modules.find((m) => m.id === moduleId);
  const activeWindow = getProjectWindow(project, activeWindowId);
  const windowProject = projectForWindow(project, activeWindowId);
  const designProject = activeModule
    ? {
        ...windowProject,
        widgets: activeModule.widgets,
        window: {
          ...windowProject.window,
          title: activeModule.name,
          width: activeModule.width,
          height: activeModule.height,
        },
      }
    : windowProject;
  useEffect(() => {
    setModuleId(null);
    setFilter('');
  }, [activeWindowId]);
  useEffect(() => {
    if (moduleId && !activeModule) setModuleId(null);
  }, [moduleId, activeModule]);
  const selected = designProject.widgets.find((w) => w.id === selectedId);
  const selectedWidgets = designProject.widgets.filter((widget) => selectedIds.includes(widget.id));
  const editScope: { kind: 'window' | 'module'; id: string } = moduleId
    ? { kind: 'module', id: moduleId }
    : { kind: 'window', id: activeWindowId };
  const scopeKey = `${project.id}/${editScope.kind}/${editScope.id}`;
  const scopeWidgets = (source: Project) =>
    moduleId
      ? (source.modules.find((module) => module.id === moduleId)?.widgets ?? [])
      : getProjectWindow(source, activeWindowId).widgets;
  const inspectActiveWindow = () => {
    store.cancelTransaction();
    setModuleId(null);
    store.inspectWindow();
  };
  const notify = (text: string, error = false) => {
    if (!mounted.current) return;
    setToast({ text, error });
  };
  const enqueuePreview = (next: Project, windowId?: string) => {
    const generation = previewGeneration.current;
    const task = previewQueue.current
      .catch(() => {})
      .then(async () => {
        if (!mounted.current || state.closing || generation !== previewGeneration.current) return;
        const result = await native.openPreview(next, windowId);
        if (result.warnings.length) notify(result.warnings.join('\n'));
      });
    previewQueue.current = task;
    return task;
  };
  useEffect(() => {
    if (!native.isDesktop()) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void native
      .onPreviewClosed(() => {
        previewGeneration.current++;
        setPreview(false);
      })
      .then((fn) => {
        if (cancelled) fn();
        else dispose = fn;
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = project.locale;
    localStorage.setItem('quickgui.locale', project.locale);
  }, [project.locale]);
  useEffect(() => {
    if (state.closing) return;
    const timer = setTimeout(() => {
      try {
        engine.applyProject(project);
        if (preview && native.isDesktop())
          void enqueuePreview(project).catch((e) => notify(String(e), true));
      } catch (e) {
        engine.log(`Preview keeps previous version: ${errorText(e)}`, 'warning');
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [project, engine, preview, state.closing]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), toast.error ? 9000 : 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!simulationAvailable) {
      if (simulate) setSimulate(false);
      return;
    }
    if (!simulate) return;
    const start = Date.now();
    const timer = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      try {
        if (project.variables.some((v) => v.id === 'temperature'))
          engine.setVariable(
            'temperature',
            Math.round((42.6 + Math.sin(elapsed / 3) * 8) * 10) / 10,
          );
        if (project.variables.some((v) => v.id === 'pressure'))
          engine.setVariable(
            'pressure',
            Math.round((0.36 + Math.sin(elapsed / 5) * 0.04) * 100) / 100,
          );
      } catch (e) {
        engine.log(String(e), 'error');
      }
    }, 500);
    return () => clearInterval(timer);
  }, [simulate, simulationAvailable, engine, project.variables]);
  const updateWidget = (id: string, patch: Partial<Widget>) => {
    const candidate = designProject.widgets.find((widget) => widget.id === id);
    if (candidate && inheritedFlag(candidate, designProject.widgets, 'locked')) {
      notify(zh ? '请先解除控件锁定' : 'Unlock this widget before editing', true);
      return;
    }
    if (patch.parentId && subtreeIds(designProject.widgets, id).has(patch.parentId)) {
      notify(
        zh
          ? '父容器不能是自身或后代控件'
          : 'A widget cannot be parented to itself or its descendants',
        true,
      );
      return;
    }
    if (moduleId)
      store.update((p) => {
        const widget = p.modules.find((m) => m.id === moduleId)?.widgets.find((w) => w.id === id);
        if (widget) Object.assign(widget, patch, { id });
      });
    else store.updateWidget(id, patch);
  };
  const addWidget = (type: Widget['type'], x?: number, y?: number) => {
    if (moduleId) {
      const widget = createWidget(type, x, y, 2);
      store.update((p) => p.modules.find((m) => m.id === moduleId)!.widgets.push(widget));
      store.select(widget.id);
    } else store.addWidget(type, x, y);
  };
  const updateMany = (patches: WidgetPatch[]) =>
    store.update((source) => {
      const widgets = scopeWidgets(source);
      for (const { id, patch } of patches) {
        const widget = widgets.find((item) => item.id === id);
        if (!widget || inheritedFlag(widget, widgets, 'locked')) continue;
        if (patch.parentId && subtreeIds(widgets, id).has(patch.parentId)) continue;
        Object.assign(widget, patch, { id });
      }
    });
  const copyCurrent = async (cut = false) => {
    const current = store.getSnapshot(),
      source = current.project;
    if (!source) return;
    const ids = [...current.selectedIds],
      widgets = scopeWidgets(source),
      roots = selectionRoots(widgets, ids);
    const subtree = new Set(roots.flatMap((widget) => [...subtreeIds(widgets, widget.id)]));
    if (
      cut &&
      widgets.some(
        (widget) =>
          subtree.has(widget.id) &&
          (inheritedFlag(widget, widgets, 'locked') ||
            store.getDraft(widget.id, scopeKey) !== undefined),
      )
    )
      throw new Error(
        zh
          ? '剪切前请解除锁定并处理 CODE 草稿。'
          : 'Unlock widgets and resolve CODE drafts before cutting.',
      );
    const positions: Record<string, Point> = {};
    const canvas = document.querySelector<HTMLElement>('[data-testid="design-canvas"]');
    if (canvas) {
      const bounds = canvas.getBoundingClientRect(),
        scale = bounds.width / designProject.window.width;
      for (const root of roots) {
        const node = canvas
          .querySelector<HTMLElement>(`[data-widget="${CSS.escape(root.id)}"]`)
          ?.closest('.qg-design-widget');
        if (node) {
          const box = node.getBoundingClientRect();
          positions[root.id] = {
            x: (box.left - bounds.left) / scale,
            y: (box.top - bounds.top) / scale,
          };
        }
      }
    }
    const bundle = copySelection(source, editScope, ids, clipboardSession.current, positions);
    await writeClipboard(bundle);
    if (cut) {
      if (
        store.getSnapshot().project?.revision !== source.revision ||
        JSON.stringify(store.getSnapshot().selectedIds) !== JSON.stringify(ids)
      )
        throw new Error(
          zh
            ? '已复制，但工程或选择已变化，未删除源控件。'
            : 'Copied, but the selection or project changed; source widgets were retained.',
        );
      await executeCommand('delete');
    }
    notify(cut ? (zh ? '已剪切控件' : 'Widgets cut') : zh ? '已复制控件' : 'Widgets copied');
  };
  const commitPaste = (plan: PastePlan) => {
    const current = store.getSnapshot().project;
    if (!current) return;
    const candidate = applyPastePlan(current, plan);
    store.update((next) => Object.assign(next, candidate));
    store.setSelection(plan.rootIds, plan.rootIds.at(-1));
    setPasteReview(null);
    notify(zh ? '控件及依赖已粘贴' : 'Widgets and dependencies pasted');
  };
  const clipboardCopy = () =>
    onCopy ? onCopy(project, editScope, store.getSnapshot().selectedIds) : copyCurrent();
  const clipboardCut = () =>
    onCut ? onCut(project, editScope, store.getSnapshot().selectedIds) : copyCurrent(true);
  const clipboardPaste = async (point?: Point) => {
    if (onPaste) {
      await onPaste(project, editScope, point);
      return;
    }
    const bundle = await readClipboard(),
      current = store.getSnapshot().project;
    if (!current) return;
    if (bundle.source.sessionKey === clipboardSession.current) {
      commitPaste(
        preparePaste(current, bundle, editScope, point, {
          sameDocument: true,
          sessionKey: clipboardSession.current,
          currentWindowId: activeWindowId,
        }),
      );
    } else setPasteReview({ bundle, scope: editScope, point });
  };
  const executeCommand = async (command: DesignerCommand, point?: Point) => {
    try {
      if (command === 'undo') {
        store.undo();
        return;
      }
      if (command === 'redo') {
        store.redo();
        return;
      }
      if (command === 'clear-selection') {
        if (store.getSnapshot().transactionLabel) store.cancelTransaction();
        else store.setSelection([]);
        return;
      }
      if (command === 'select-all') {
        store.setSelection(
          designProject.widgets
            .filter(
              (widget) =>
                !inheritedFlag(widget, designProject.widgets, 'hidden') &&
                !inheritedFlag(widget, designProject.widgets, 'locked'),
            )
            .map((widget) => widget.id),
        );
        return;
      }
      if (command === 'copy') {
        await clipboardCopy?.();
        return;
      }
      if (command === 'cut') {
        await clipboardCut?.();
        return;
      }
      if (command === 'paste') {
        await clipboardPaste?.(point);
        return;
      }
      const current = store.getSnapshot(),
        source = current.project;
      if (!source) return;
      const widgets = scopeWidgets(source),
        roots = selectionRoots(widgets, current.selectedIds);
      if (!roots.length) return;
      if (['lock', 'unlock', 'hide', 'show'].includes(command)) {
        store.update((next) => {
          const list = scopeWidgets(next),
            targets = new Set(roots.map((widget) => widget.id));
          if (command === 'unlock' || command === 'show')
            for (const root of roots) {
              let parent = root.parentId;
              const seen = new Set<string>();
              while (parent && !seen.has(parent)) {
                targets.add(parent);
                seen.add(parent);
                parent = list.find((widget) => widget.id === parent)?.parentId;
              }
            }
          for (const widget of list)
            if (targets.has(widget.id))
              widget.editor = {
                ...widget.editor,
                ...(['lock', 'unlock'].includes(command)
                  ? { locked: command === 'lock' }
                  : { hidden: command === 'hide' }),
              };
        });
        return;
      }
      if (roots.some((widget) => inheritedFlag(widget, widgets, 'locked'))) {
        notify(zh ? '请先解除控件锁定' : 'Unlock selected widgets first', true);
        return;
      }
      if (command === 'delete') {
        const deleted = new Set(roots.flatMap((widget) => [...subtreeIds(widgets, widget.id)]));
        if (widgets.some((widget) => deleted.has(widget.id) && widget.editor?.locked))
          throw new Error(
            zh
              ? '选中容器包含锁定控件，请先解锁。'
              : 'The selected subtree contains locked widgets. Unlock them first.',
          );
        if ([...deleted].some((id) => store.getDraft(id, scopeKey) !== undefined))
          throw new Error(
            zh
              ? '选中控件含未应用 CODE 草稿，请先应用或还原。'
              : 'Resolve unapplied CODE drafts before deleting these widgets.',
          );
        store.update((next) => {
          const list = scopeWidgets(next);
          list.splice(0, list.length, ...list.filter((widget) => !deleted.has(widget.id)));
          if (moduleId) {
            const module = next.modules.find((item) => item.id === moduleId)!;
            module.exposedProps = Object.fromEntries(
              Object.entries(module.exposedProps).filter(
                ([, value]) => !deleted.has(value.widgetId),
              ),
            );
          }
        });
        store.setSelection([]);
        return;
      }
      if (command === 'duplicate') {
        const copies = roots.flatMap((widget) => cloneSubtree(widgets, widget.id)),
          originalIds = new Set(widgets.map((widget) => widget.id));
        const copyRoots = copies.filter(
          (widget) => !widget.parentId || originalIds.has(widget.parentId),
        );
        store.update((next) => scopeWidgets(next).push(...copies));
        store.setSelection(copyRoots.map((widget) => widget.id));
        return;
      }
      if (['front', 'back', 'raise', 'lower'].includes(command)) {
        store.update((next) => {
          const list = scopeWidgets(next),
            reordered = reorderedWidgets(
              list,
              current.selectedIds,
              command as 'front' | 'back' | 'raise' | 'lower',
            );
          list.splice(0, list.length, ...reordered);
        });
        return;
      }
      const patches = arrangementPatches(widgets, current.selectedIds, command);
      if (patches.length) updateMany(patches);
    } catch (error) {
      notify(errorText(error), true);
    }
  };
  const commandRef = useRef(executeCommand);
  commandRef.current = executeCommand;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (isEditingText(event.target) || document.querySelector('[role="dialog"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        store.saveRecovery();
        return;
      }
      const command = commandForKey(event);
      if (!command || (section !== 'design' && command !== 'undo' && command !== 'redo')) return;
      event.preventDefault();
      void commandRef.current(command);
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [section, store, onCopy, onCut, onPaste]);
  const deleteWidget = () => {
    void executeCommand('delete');
  };
  const createModule = () => {
    const source = selected ?? createWidget('panel', 32, 32, 2);
    const children = cloneSubtree(selected ? designProject.widgets : [source], source.id, true);
    const child = children.find((w) => !w.parentId)!;
    const module: ComponentModule = {
      id: uid('module'),
      name: `${source.name}模块`,
      version: '1.0.0',
      width: source.layout.width,
      height: source.layout.height,
      widgets: children,
      exposedProps: Object.fromEntries(
        getWidgetDefinition(
          child.type,
          child.definitionVersion ?? 1,
          project.modules.find((module) => module.id === child.moduleId),
        )
          .properties.filter((definition) =>
            ['text', 'value', 'enabled', 'visible'].includes(definition.key),
          )
          .map((definition) => [
            definition.key,
            {
              widgetId: child.id,
              property: definition.key,
              default: child.props[definition.key] ?? definition.fallbackValue,
            },
          ]),
      ),
    };
    store.update((p) => p.modules.push(module));
    setLeftTab('modules');
    notify(
      zh
        ? '模块已创建，可编辑定义或添加实例'
        : 'Module created. Edit its definition or add an instance.',
    );
  };
  const addModuleInstance = (module: ComponentModule) => {
    const widget = createWidget('module', 32, 32, 2);
    widget.name = module.name;
    widget.moduleId = module.id;
    widget.layout.width = module.width;
    widget.layout.height = module.height;
    widget.props = Object.fromEntries(
      Object.entries(module.exposedProps).map(([key, value]) => [key, value.default]),
    );
    store.update((p) => getProjectWindow(p, activeWindowId).widgets.push(widget));
    setModuleId(null);
    store.select(widget.id);
    store.setSection('design');
  };
  const installModule = (module: ComponentModule) => {
    const current = store.getSnapshot().project;
    if (!current) return;
    const existing = current.modules.find((item) => item.id === module.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(module)) {
      setPendingModule(null);
      setLeftTab('modules');
      notify(zh ? '组件包已存在' : 'Component package already exists');
      return;
    }
    const next = structuredClone(current),
      installed = structuredClone(module);
    if (existing) {
      installed.packageIdentity ??= {
        id: module.id,
        name: module.name,
        version: module.version,
        width: module.width,
        height: module.height,
      };
      installed.id = uid('module');
      installed.name = `${module.name} (${current.modules.filter((item) => item.name.startsWith(module.name)).length + 1})`;
    }
    next.modules.push(installed);
    try {
      validateProject(next);
    } catch (error) {
      notify(errorText(error), true);
      return;
    }
    store.update((p) => Object.assign(p, next));
    setPendingModule(null);
    setLeftTab('modules');
    notify(zh ? '组件包已导入' : 'Component package imported');
  };
  const stageProject = (raw: Project) => {
    if (!mounted.current || closeInProgress.current) return;
    const next = validateProject(raw);
    const runsCode =
      next.modules.some((m) => Boolean(m.implementation)) ||
      next.flows.some((f) => f.enabled && f.nodes.some(isAutomaticEventSource));
    if (runsCode) setPendingProject(next);
    else {
      requestClose(next);
    }
  };
  const requestClose = (next?: Project) => {
    if (closeInProgress.current) return;
    setProjectMenu(false);
    setCloseError('');
    setCloseRequest({ next });
  };
  const confirmClose = async (saveToFile: boolean) => {
    if (closeInProgress.current || !closeRequest) return;
    closeInProgress.current = true;
    setCloseBusy(true);
    setCloseError('');
    try {
      if (saveToFile) {
        const bytes = exportProject(project, drafts);
        if (native.isDesktop()) {
          if (!(await native.saveProject(project))) return;
        } else download(projectFilename(project.name), bytes as BlobPart);
      }
      store.beginClose(!saveToFile);
      previewGeneration.current++;
      setPreview(false);
      setSimulate(false);
      const warnings = await engine.closeProject();
      store.finishClose(warnings);
      if (closeRequest.next) store.replaceProject(closeRequest.next);
    } catch (error) {
      if (store.getSnapshot().closing) store.cancelClose();
      setCloseError(errorText(error));
    } finally {
      closeInProgress.current = false;
      if (mounted.current) setCloseBusy(false);
    }
  };
  const exportOriginal = () => {
    try {
      const bytes = exportProject(project, drafts);
      download(projectFilename(project.name), bytes as BlobPart);
      notify(zh ? '工程已导出' : 'Project exported');
    } catch (e) {
      notify(errorText(e), true);
    }
    setExportMenu(false);
  };
  const exportSource = async () => {
    setExportMenu(false);
    try {
      exportProject(project, drafts);
      if (!native.isDesktop())
        throw new Error(
          zh
            ? '独立源码导出请使用桌面版，或运行 node scripts/export-project.mjs <quickgui.json> <output>。'
            : 'Use the desktop app, or node scripts/export-project.mjs <quickgui.json> <output>.',
        );
      const path = await native.exportSource(project);
      if (path) notify(`${zh ? '源码已导出至' : 'Source exported to'} ${path}`);
    } catch (e) {
      notify(errorText(e), true);
    }
  };
  const buildRuntime = async () => {
    if (buildInProgress.current) return;
    buildInProgress.current = true;
    setExportMenu(false);
    let unlisten: (() => void) | undefined;
    const recordProgress = ({ stage, message }: native.BuildProgress) => {
      if (!mounted.current) return;
      const text = `[build:${stage}] ${message}`;
      setBuildLogs((logs) =>
        stage === 'error' && logs.at(-1)?.message === text
          ? logs
          : [
              ...logs.slice(-999),
              {
                id: uid('build-log'),
                time: Date.now(),
                level: stage === 'error' ? 'error' : 'info',
                message: text,
              },
            ],
      );
      setBuildProgress(`${stage}: ${message}`);
    };
    try {
      exportProject(project, drafts);
      if (!native.isDesktop())
        throw new Error(
          zh
            ? '独立应用构建请使用桌面版。'
            : 'Use the desktop app to build a standalone application.',
        );
      setBuildLogs([]);
      followConsole.current = true;
      setShowConsole(true);
      recordProgress({ stage: 'prepare', message: zh ? '准备构建…' : 'Preparing build…' });
      unlisten = await native.onBuildProgress(recordProgress);
      const result = await native.buildRuntime(project);
      if (result)
        notify(
          `${zh ? '构建完成' : 'Build complete'}: ${result.artifactDir} (${result.signingStatus})`,
        );
      else
        recordProgress({
          stage: 'cancelled',
          message: zh
            ? '未选择输出目录，构建已取消。'
            : 'No output directory selected; build cancelled.',
        });
    } catch (e) {
      recordProgress({ stage: 'error', message: errorText(e) });
      notify(errorText(e), true);
    } finally {
      unlisten?.();
      buildInProgress.current = false;
      if (mounted.current) setBuildProgress(null);
    }
  };
  const openProject = async () => {
    setProjectMenu(false);
    if (native.isDesktop()) {
      try {
        const p = await native.loadProject();
        if (p) {
          stageProject(p);
        }
      } catch (e) {
        notify(errorText(e), true);
      }
    } else fileInput.current?.click();
  };
  const openPreview = async () => {
    const generation = previewGeneration.current;
    try {
      if (native.isDesktop()) {
        await enqueuePreview(project, activeWindowId);
      } else {
        engine.applyProject(project);
        engine.windowAction('open', activeWindowId);
      }
      if (generation === previewGeneration.current) setPreview(true);
    } catch (e) {
      notify(errorText(e), true);
    }
  };
  const runEntries = project.flows
    .filter((flow) => flow.enabled)
    .flatMap((flow) =>
      manualFlowEntries(flow).map((node) => ({
        flow,
        node,
        key: JSON.stringify([flow.id, node.id]),
      })),
    );
  const runEntry = runEntries.find((entry) => entry.key === runEntryKey) ?? runEntries[0];
  const run = () => {
    if (!snapshot.running) engine.start();
    if (runEntry)
      void engine
        .runFlow(runEntry.flow.id, null, runEntry.node.id)
        .catch((e) => notify(errorText(e), true));
  };
  const tabs: [Section, typeof LayoutDashboard, string][] = [
    ['design', LayoutDashboard, t.design],
    ['appearance', Palette, t.appearance],
    ['languages', Languages, t.languages],
    ['flows', GitBranch, t.flows],
    ['scripts', Code2, t.scripts],
    ['data', SlidersHorizontal, t.data],
    ['connections', Radio, t.connections],
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img src="/quickgui.svg" alt="QuickGUI" />
          <strong>QuickGUI</strong>
          <span>DESIGNER</span>
        </div>
        <div
          ref={projectMenuRef}
          className="project-menu-wrap"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && projectMenu) {
              event.preventDefault();
              event.stopPropagation();
              setProjectMenu(false);
              projectMenuRef.current?.querySelector('button')?.focus();
            }
          }}
        >
          <button
            className="project-switch"
            aria-expanded={projectMenu}
            aria-controls="project-dropdown"
            onClick={() => {
              setExportMenu(false);
              setProjectMenu(!projectMenu);
            }}
          >
            <span className="project-dot" />
            {project.name}
            <ChevronDown size={13} />
          </button>
          {projectMenu && (
            <div id="project-dropdown" className="dropdown project-dropdown">
              <button
                onClick={() => {
                  setProjectMenu(false);
                  setNameAction('create');
                }}
              >
                <FilePlus2 size={15} />
                {t.new}
              </button>
              <button
                onClick={() => {
                  setProjectMenu(false);
                  setNameAction('rename');
                }}
              >
                <FilePenLine size={15} />
                {zh ? '重命名工程' : 'Rename project'}
              </button>
              <button onClick={() => requestClose()}>
                <X size={15} />
                {zh ? '关闭工程' : 'Close project'}
              </button>
              <button onClick={() => void openProject()}>
                <FolderOpen size={15} />
                {t.open}
              </button>
              <button
                onClick={() => {
                  store.saveRecovery();
                  setProjectMenu(false);
                  if (native.isDesktop())
                    void native.saveProject(project).catch((e) => notify(String(e), true));
                  else exportOriginal();
                }}
              >
                <Save size={15} />
                {t.save}
              </button>
            </div>
          )}
        </div>
        <div className="save-indicator">
          <span className={state.dirty ? 'saving-dot' : 'saved-dot'} />
          {state.dirty ? t.unsaved : t.saved}
        </div>
        <div className="topbar-spacer" />
        <button
          className="icon-button"
          title="Language"
          onClick={() =>
            store.update((p) => {
              p.locale = p.locale === 'zh-CN' ? 'en' : 'zh-CN';
            })
          }
        >
          <Languages size={17} />
        </button>
        <button className="icon-button" title="Theme" onClick={onToggleTheme}>
          {designerTheme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <span className="toolbar-divider" />
        <button className="button preview-button" onClick={() => void openPreview()}>
          <Play size={14} fill="currentColor" />
          {t.preview}
        </button>
        <div
          ref={exportMenuRef}
          className="export-menu-wrap"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && exportMenu) {
              event.preventDefault();
              event.stopPropagation();
              setExportMenu(false);
              exportMenuRef.current?.querySelector('button')?.focus();
            }
          }}
        >
          <button
            className="button primary"
            aria-expanded={exportMenu}
            aria-controls="export-dropdown"
            onClick={() => {
              setProjectMenu(false);
              setExportMenu(!exportMenu);
            }}
          >
            <Download size={14} />
            {t.export}
            <ChevronDown size={13} />
          </button>
          {exportMenu && (
            <div id="export-dropdown" className="dropdown export-dropdown">
              <button onClick={exportOriginal}>
                <Package size={18} />
                <span>
                  {t.project}
                  <small>{t.exportHint}</small>
                </span>
              </button>
              <button onClick={() => void exportSource()}>
                <Code2 size={18} />
                <span>
                  {t.source}
                  <small>{t.sourceHint}</small>
                </span>
              </button>
              <button disabled={buildProgress !== null} onClick={() => void buildRuntime()}>
                <Monitor size={18} />
                <span>
                  {zh ? '独立运行应用' : 'Standalone application'}
                  <small>
                    {zh ? '本机平台构建 · C 提前编译' : 'Native build · ahead-of-time C'}
                  </small>
                </span>
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="workspace-tabs">
        <div className="workspace-name">
          <CircuitBoard size={15} />
          <span>{zh ? '工作空间' : 'WORKSPACE'}</span>
        </div>
        <nav>
          {tabs.map(([id, Icon, label]) => (
            <button
              key={id}
              className={section === id ? 'active' : ''}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => store.setSection(id)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
        <div className="workspace-tools">
          <button
            className="icon-button"
            title={t.undo}
            onClick={store.undo}
            disabled={!state.past.length}
          >
            <RotateCcw size={15} />
          </button>
          <button
            className="icon-button"
            title={t.redo}
            onClick={store.redo}
            disabled={!state.future.length}
          >
            <RotateCw size={15} />
          </button>
          <span className="toolbar-divider" />
          <button
            className={`icon-button ${state.inspector === 'window' ? 'selected' : ''}`}
            title={t.window}
            onClick={inspectActiveWindow}
          >
            <Monitor size={16} />
          </button>
        </div>
      </div>
      <main
        className={`workspace-body ${section === 'flows' ? `flow-page-layout ${showConsole ? 'flow-console-visible' : ''}` : ''}`}
      >
        {section === 'design' && (
          <aside className="left-panel">
            <WindowManager
              project={project}
              activeWindowId={activeWindowId}
              locale={project.locale}
              onSelect={(id) => {
                setModuleId(null);
                setFilter('');
                store.setActiveWindow(id);
              }}
              onCreate={(name) => {
                setModuleId(null);
                store.addWindow(name);
              }}
              onRename={store.renameWindow}
              onDelete={store.deleteWindow}
              onStartup={store.setWindowOpenOnStart}
            />
            <div className="left-tabs">
              {(['layers', 'library', 'modules', 'assets'] as const).map((tab) => (
                <button
                  key={tab}
                  className={leftTab === tab ? 'active' : ''}
                  onClick={() => setLeftTab(tab)}
                >
                  {t[tab]}
                </button>
              ))}
            </div>
            {leftTab === 'layers' && (
              <>
                <div className="panel-search">
                  <Search size={13} />
                  <input
                    placeholder={zh ? '查找图层…' : 'Search layers…'}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
                <button
                  className={`window-row ${state.inspector === 'window' ? 'active' : ''}`}
                  onClick={inspectActiveWindow}
                >
                  <Monitor size={15} />
                  <span>{activeModule ? activeModule.name : activeWindow.name}</span>
                  <ChevronDown size={12} />
                </button>
                <LayerTree
                  widgets={designProject.widgets}
                  selectedIds={selectedIds}
                  filter={filter}
                  locale={project.locale}
                  onSelectionChange={store.setSelection}
                  onCommand={(command) => {
                    void executeCommand(command);
                  }}
                  canUndo={!!state.past.length}
                  canRedo={!!state.future.length}
                  onCopy={clipboardCopy}
                  onCut={clipboardCut}
                  onPaste={clipboardPaste}
                />
                <div className="left-footer">
                  <button onClick={() => setLeftTab('library')}>
                    <Plus size={14} />
                    {zh ? '添加控件' : 'Add widget'}
                  </button>
                  <button className="icon-button" title={t.modules} onClick={createModule}>
                    <Puzzle size={15} />
                  </button>
                </div>
              </>
            )}
            {leftTab === 'library' && (
              <Library onAdd={(type) => addWidget(type)} locale={project.locale} />
            )}
            {leftTab === 'modules' && (
              <div className="module-list">
                <div className="panel-intro">
                  {zh
                    ? '复用控件组合，独立编辑定义与实例。'
                    : 'Reusable widgets with independent instance overrides.'}
                </div>
                <button className="button full" onClick={createModule}>
                  <Plus size={14} />
                  {zh ? '从选中控件创建' : 'Create from selection'}
                </button>
                <button
                  className="button full"
                  style={{ marginTop: 8 }}
                  onClick={() => componentInput.current?.click()}
                >
                  <FolderOpen size={14} />
                  {zh ? '导入组件包' : 'Import component package'}
                </button>
                {project.modules.map((module) => (
                  <div className="module-card" key={module.id}>
                    <Puzzle size={20} />
                    <strong>{module.name}</strong>
                    <small>
                      v{module.version} · {module.widgets.length} {zh ? '个控件' : 'widgets'}
                    </small>
                    <div>
                      <button onClick={() => addModuleInstance(module)}>
                        {zh ? '添加实例' : 'Add instance'}
                      </button>
                      {module.implementation ? (
                        <button
                          onClick={() => {
                            try {
                              download(
                                `${module.name}.qgcomponent`,
                                exportComponentPackage(module, project) as BlobPart,
                              );
                            } catch (error) {
                              notify(errorText(error), true);
                            }
                          }}
                        >
                          {zh ? '导出组件包' : 'Export package'}
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            store.cancelTransaction();
                            setModuleId(module.id);
                            store.select(module.widgets[0]?.id ?? null);
                          }}
                        >
                          {zh ? '编辑定义' : 'Edit definition'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {leftTab === 'assets' && (
              <div className="module-list">
                <button className="button full" onClick={() => assetInput.current?.click()}>
                  <Plus size={14} />
                  {zh ? '导入图像资源' : 'Import image'}
                </button>
                {project.assets.map((asset) => (
                  <div className="asset-card" key={asset.id}>
                    <img src={asset.data} alt={asset.name} />
                    <span>{asset.name}</span>
                    <button
                      className="icon-button"
                      title={zh ? '应用到选中图片' : 'Apply to image'}
                      disabled={selected?.type !== 'image'}
                      onClick={() =>
                        selected &&
                        updateWidget(selected.id, {
                          props: { ...selected.props, assetId: asset.id },
                        })
                      }
                    >
                      <Check size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}
        <section className="center-panel">
          {section === 'design' && (
            <CanvasEditor
              key={`${activeWindowId}:${activeModule?.id ?? 'window'}`}
              heading={
                <>
                  <span>{zh ? '画布' : 'CANVAS'}</span>
                  <ChevronRight size={12} />
                  <strong title={activeModule ? activeModule.name : activeWindow.name}>
                    {activeModule ? activeModule.name : activeWindow.name}
                  </strong>
                  {activeModule && (
                    <button
                      className="module-exit"
                      onClick={() => {
                        store.cancelTransaction();
                        setModuleId(null);
                        store.select(null);
                      }}
                    >
                      {zh ? '退出模块定义' : 'Exit module'}
                    </button>
                  )}
                </>
              }
              project={designProject}
              selectedId={selectedId}
              selectedIds={selectedIds}
              scopeKey={scopeKey}
              onSelect={store.select}
              onSelectionChange={store.setSelection}
              onUpdate={updateWidget}
              onUpdateMany={updateMany}
              onBeginTransaction={store.beginTransaction}
              onCommitTransaction={store.commitTransaction}
              onCancelTransaction={store.cancelTransaction}
              onCommand={(command, point) => {
                void executeCommand(command, point);
              }}
              onCopy={() => {
                void executeCommand('copy');
              }}
              onCut={() => {
                void executeCommand('cut');
              }}
              onPaste={(point) => {
                void executeCommand('paste', point);
              }}
              canUndo={!!state.past.length}
              canRedo={!!state.future.length}
              onAdd={addWidget}
            />
          )}
          {section === 'appearance' && (
            <AppearancePanel project={project} onChange={store.update} />
          )}
          {section === 'languages' && (
            <TranslationsPanel project={project} onChange={store.update} />
          )}
          {section === 'flows' && (
            <FlowEditor
              project={project}
              onChange={updateFlows}
              activeNodes={snapshot.activeNodes}
              locale={project.locale}
              designerTheme={designerTheme}
            />
          )}
          {section === 'scripts' && (
            <ScriptPanel
              project={project}
              onChange={(p) => store.update(p)}
              engine={engine}
              notify={notify}
            />
          )}
          {section === 'data' && (
            <DataPanel
              project={project}
              engine={engine}
              onChange={(p) => store.update(p)}
              notify={notify}
            />
          )}
          {section === 'connections' && (
            <ConnectionsPanel project={project} onChange={(p) => store.update(p)} notify={notify} />
          )}
          {workspaceConsoleVisible && (
            <section className="console-panel">
              <header>
                <button onClick={() => setShowConsole(false)}>
                  <Terminal size={14} />
                  <span>{t.console}</span>
                  <span className="count-pill">{consoleLogs.length}</span>
                </button>
                <div>
                  {simulationAvailable && (
                    <label className="simulate-toggle">
                      <input
                        type="checkbox"
                        checked={simulate}
                        onChange={(e) => setSimulate(e.target.checked)}
                      />
                      {t.simulate}
                      <span className="simulated-label">SIM</span>
                    </label>
                  )}
                  <button
                    className="icon-button"
                    title={t.clear}
                    onClick={() => {
                      engine.clearLogs();
                      setBuildLogs([]);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                  {runEntries.length > 1 && (
                    <select
                      className="console-entry"
                      aria-label={zh ? '运行入口' : 'Run entry'}
                      value={runEntry?.key ?? ''}
                      onChange={(event) => setRunEntryKey(event.target.value)}
                    >
                      {runEntries.map((entry) => (
                        <option key={entry.key} value={entry.key}>
                          {entry.flow.name} · {entry.node.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    className="icon-button"
                    title={t.run}
                    onClick={run}
                    disabled={!runEntry && snapshot.running}
                  >
                    <Play size={13} />
                  </button>
                  <button className="icon-button" title={t.stop} onClick={engine.stop}>
                    <Square size={12} />
                  </button>
                </div>
              </header>
              <div
                className="console-content"
                ref={consoleContent}
                onScroll={(event) => {
                  const element = event.currentTarget;
                  followConsole.current =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 24;
                }}
              >
                {consoleLogs.length ? (
                  consoleLogs.map((log) => (
                    <div className={`log-row ${log.level}`} key={log.id}>
                      <time>
                        {new Date(log.time).toLocaleTimeString('en-GB', { hour12: false })}
                      </time>
                      <span className="log-level">{log.level}</span>
                      <span>{log.message}</span>
                    </div>
                  ))
                ) : (
                  <div className="console-empty">
                    <CircleDot size={12} />
                    {t.emptyLogs}
                  </div>
                )}
              </div>
            </section>
          )}
        </section>
        {section === 'design' && (
          <aside className="right-panel">
            {state.inspector === 'window' || !selected ? (
              <WindowInspector
                key={activeWindowId}
                project={windowProject}
                onWindowChange={(patch) => store.updateWindow(activeWindowId, patch)}
                onPublishChange={(patch) =>
                  store.update((p) => {
                    Object.assign(p.publish, patch);
                  })
                }
                onAsset={(asset) =>
                  store.update((p) => {
                    p.assets.push(asset);
                  })
                }
                locale={project.locale}
              />
            ) : (
              <>
                <Inspector
                  widget={selected}
                  selectedWidgets={selectedWidgets}
                  project={designProject}
                  onUpdate={(patch) => updateWidget(selected.id, patch)}
                  onUpdateMany={updateMany}
                  onBeginTransaction={store.beginTransaction}
                  onCommitTransaction={store.commitTransaction}
                  onCancelTransaction={store.cancelTransaction}
                  draft={store.getDraft(selected.id, scopeKey)}
                  onDraft={(text) => store.setDraft(selected.id, text, scopeKey)}
                  onDelete={deleteWidget}
                  onDuplicate={() => {
                    void executeCommand('duplicate');
                  }}
                  locale={project.locale}
                />
              </>
            )}
          </aside>
        )}
      </main>
      <footer className="statusbar">
        <span>
          <span className="saved-dot" />
          {native.isDesktop() ? t.desktop : t.browser}
        </span>
        {(!resourceSection || buildProgress !== null) && (
          <button onClick={() => setShowConsole(!showConsole)}>
            <Terminal size={12} />
            {t.console}
          </button>
        )}
        <div className="status-spacer" />
        <span>
          {activeWindow.widgets.length} {zh ? '个控件' : 'widgets'} ·{' '}
          {listProjectWindows(project).length} {zh ? '个窗口' : 'windows'}
        </span>
        {Object.keys(drafts).length > 0 && (
          <span className="draft-warning">
            {Object.keys(drafts).length} {zh ? '个未应用草稿' : 'unapplied drafts'}
          </span>
        )}
        <span>rev {project.revision}</span>
        <span>QuickGUI 0.1</span>
      </footer>
      {closeRequest && (
        <div className="modal-backdrop">
          <div
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label={zh ? '关闭当前工程' : 'Close current project'}
          >
            <header>
              <strong>{zh ? '关闭当前工程' : 'Close current project'}</strong>
              <button
                className="icon-button"
                disabled={closeBusy}
                aria-label={zh ? '取消关闭' : 'Cancel closing'}
                onClick={() => {
                  if (closeError) engine.start();
                  setCloseRequest(null);
                }}
              >
                <X size={18} />
              </button>
            </header>
            <section>
              <h3>{project.name}</h3>
              <p>
                {zh
                  ? '关闭会停止流程、C 任务、模拟数据和构建，并关闭预览窗口。原始工程文件与运行历史不会删除。'
                  : 'Closing stops flows, C tasks, simulation and builds, and closes the preview. Source files and runtime history are kept.'}
              </p>
              <p>
                {zh
                  ? '可保存导出文件，或保留本机恢复副本（包括未应用的 CODE 草稿）。本机恢复副本不能代替文件备份。'
                  : 'Save an exported file, or keep a local recovery copy including unapplied CODE drafts. Local recovery is not a file backup.'}
              </p>
              {Object.keys(drafts).length > 0 && (
                <p className="close-draft-note">
                  {zh
                    ? `有 ${Object.keys(drafts).length} 个未应用草稿，导出前需要先处理；可选择保留恢复副本。`
                    : `${Object.keys(drafts).length} unapplied drafts must be resolved before file export; you can keep a recovery copy instead.`}
                </p>
              )}
              {closeRequest.next && (
                <p>
                  {zh ? '关闭后将打开：' : 'Next project: '}
                  {closeRequest.next.name}
                </p>
              )}
              {closeError && (
                <p role="alert" className="form-error welcome-error">
                  {closeError}
                </p>
              )}
              <div className="settings-actions close-actions">
                <button
                  className="button"
                  disabled={closeBusy}
                  onClick={() => {
                    if (closeError) engine.start();
                    setCloseRequest(null);
                  }}
                >
                  {zh ? '取消' : 'Cancel'}
                </button>
                <button
                  className="button"
                  disabled={closeBusy || Object.keys(drafts).length > 0}
                  onClick={() => void confirmClose(true)}
                >
                  {zh ? '保存工程并关闭' : 'Save project and close'}
                </button>
                <button
                  className="button primary"
                  disabled={closeBusy}
                  onClick={() => void confirmClose(false)}
                >
                  {closeBusy
                    ? zh
                      ? '正在关闭…'
                      : 'Closing…'
                    : zh
                      ? '保留恢复副本并关闭'
                      : 'Keep recovery and close'}
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
      {pasteReview && (
        <PasteReviewDialog
          project={project}
          bundle={pasteReview.bundle}
          scope={pasteReview.scope}
          point={pasteReview.point}
          sessionKey={clipboardSession.current}
          currentWindowId={activeWindowId}
          onConfirm={commitPaste}
          onCancel={() => setPasteReview(null)}
        />
      )}
      {nameAction && (
        <ProjectNameDialog
          mode={nameAction}
          initialName={
            nameAction === 'rename' ? project.name : zh ? '未命名工程' : 'Untitled project'
          }
          locale={project.locale}
          onCancel={() => setNameAction(null)}
          onConfirm={(name) => {
            const action = nameAction;
            setNameAction(null);
            if (action === 'create') {
              const next = createEmptyProject(name);
              next.locale = project.locale;
              requestClose(next);
            } else if (name !== project.name) {
              store.update((p) => {
                p.name = name;
              });
              notify(zh ? '工程名称已保存' : 'Project name saved');
            }
          }}
        />
      )}
      {pendingModule && (
        <div className="modal-backdrop">
          <div className="settings-modal">
            <header>
              <strong>{zh ? '导入代码组件' : 'Import code component'}</strong>
              <button className="icon-button" onClick={() => setPendingModule(null)}>
                <X size={18} />
              </button>
            </header>
            <section>
              <h3>
                {pendingModule.name} <small>v{pendingModule.version}</small>
              </h3>
              <p>
                {zh
                  ? '此组件包含会在设计器和生成应用中执行的 React / TypeScript 代码。只导入你编写或信任的组件。Shadow DOM 隔离样式，不限制代码权限。'
                  : 'This package contains React / TypeScript code that runs in the designer and exported app. Import only components you wrote or trust. Shadow DOM isolates styles, not code permissions.'}
              </p>
              <p>{Object.keys(pendingModule.implementation?.files ?? {}).join(' · ')}</p>
              <div className="settings-actions">
                <button className="button" onClick={() => setPendingModule(null)}>
                  {zh ? '取消' : 'Cancel'}
                </button>
                <button className="button primary" onClick={() => installModule(pendingModule)}>
                  {zh ? '信任并导入' : 'Trust and import'}
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
      {pendingProject && (
        <div className="modal-backdrop">
          <div className="settings-modal">
            <header>
              <strong>{zh ? '打开可执行工程' : 'Open executable project'}</strong>
              <button className="icon-button" onClick={() => setPendingProject(null)}>
                <X size={18} />
              </button>
            </header>
            <section>
              <h3>{pendingProject.name}</h3>
              <p>
                {zh
                  ? '此工程含代码组件或自动触发流程，打开后可能执行代码并连接外部设备或服务。请确认你信任其来源。'
                  : 'This project contains code components or automatically triggered flows. Opening it can execute code and connect to external devices or services. Confirm you trust its source.'}
              </p>
              <div className="settings-actions">
                <button className="button" onClick={() => setPendingProject(null)}>
                  {zh ? '取消' : 'Cancel'}
                </button>
                <button
                  className="button primary"
                  onClick={() => {
                    requestClose(pendingProject);
                    setPendingProject(null);
                  }}
                >
                  {zh ? '信任并打开' : 'Trust and open'}
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
      {preview && !native.isDesktop() && (
        <div className="modal-backdrop">
          <div
            className={`preview-modal ${(project.windows?.length ?? 0) > 0 ? 'preview-workspace-modal' : ''}`}
          >
            <header>
              <div>
                <Monitor size={16} />
                <strong>
                  {(project.windows?.length ?? 0) > 0 ? project.name : project.window.title}
                </strong>
                <span className="live-pill">LIVE</span>
              </div>
              <button
                className="icon-button"
                aria-label={t.close}
                onClick={() => setPreview(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="preview-scroll">
              <RuntimeWindows project={project} engine={engine} />
            </div>
            <footer>
              <span>
                {zh
                  ? '与发布应用共享组件与绑定 · 浏览器预览不执行 C'
                  : 'Shared renderer and bindings · C execution needs desktop'}
              </span>
              <span>
                {(project.windows?.length ?? 0) > 0
                  ? `${listProjectWindows(project).length} ${zh ? '个窗口 · 共享运行状态' : 'windows · shared runtime'}`
                  : `${project.window.width} × ${project.window.height}`}
              </span>
            </footer>
          </div>
        </div>
      )}
      {buildProgress !== null && (
        <div className={`build-progress${workspaceConsoleVisible ? ' console-open' : ''}`}>
          <Activity size={16} />
          <span>{buildProgress.slice(-300)}</span>
          <button className="button" onClick={() => void native.cancelBuild()}>
            {zh ? '取消构建' : 'Cancel build'}
          </button>
        </div>
      )}
      {toast && (
        <div role="status" className={`toast ${toast.error ? 'error' : ''}`}>
          {toast.error ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{toast.text}</span>
          <button className="icon-button" onClick={() => setToast(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}
      {state.recoveryError && <div className="recovery-warning">{state.recoveryError}</div>}
      <input
        ref={fileInput}
        hidden
        type="file"
        accept=".qgui,.json"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            stageProject(importProject(new Uint8Array(await file.arrayBuffer())));
          } catch (error) {
            notify(errorText(error), true);
          }
          e.target.value = '';
        }}
      />
      <input
        ref={componentInput}
        hidden
        type="file"
        accept=".qgcomponent"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            const module = importComponentPackage(new Uint8Array(await file.arrayBuffer()));
            if (module.implementation) setPendingModule(module);
            else installModule(module);
          } catch (error) {
            notify(errorText(error), true);
          }
          e.target.value = '';
        }}
      />
      <input
        ref={assetInput}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > 5_000_000) return notify('Image exceeds 5 MB', true);
          const data = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = reject;
            r.readAsDataURL(file);
          });
          store.update((p) =>
            p.assets.push({ id: uid('asset'), name: file.name, mime: file.type, data }),
          );
          e.target.value = '';
        }}
      />
    </div>
  );
}

function BindingsPanel({
  widget,
  project,
  onChange,
}: {
  widget: Widget;
  project: Project;
  onChange: (patch: Partial<Widget>) => void;
}) {
  const zh = project.locale === 'zh-CN';
  const property = widget.type === 'text' ? 'text' : 'value';
  const binding = widget.bindings[property];
  return (
    <div className="bindings-panel">
      <h4>
        <GitBranch size={13} />
        {zh ? '数据与事件' : 'DATA & EVENTS'}
      </h4>
      <label>
        {zh ? '数据变量' : 'Variable'}
        <select
          value={binding?.variable ?? ''}
          onChange={(e) => {
            const bindings = { ...widget.bindings };
            if (e.target.value)
              bindings[property] = {
                variable: e.target.value,
                mode: ['input', 'number', 'slider', 'switch', 'select'].includes(widget.type)
                  ? 'twoWay'
                  : 'oneWay',
              };
            else delete bindings[property];
            onChange({ bindings });
          }}
        >
          <option value="">{zh ? '未绑定' : 'Unbound'}</option>
          {project.variables.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · {v.type}
            </option>
          ))}
        </select>
      </label>
      {binding && (
        <label>
          {zh ? '绑定模式' : 'Mode'}
          <select
            value={binding.mode}
            onChange={(e) =>
              onChange({
                bindings: {
                  ...widget.bindings,
                  [property]: { ...binding, mode: e.target.value as typeof binding.mode },
                },
              })
            }
          >
            <option value="oneWay">{zh ? '单向' : 'One way'}</option>
            <option value="twoWay">{zh ? '双向' : 'Two way'}</option>
            <option value="once">{zh ? '一次性' : 'Once'}</option>
          </select>
        </label>
      )}
      <label>
        {widget.type === 'button' ? 'onClick' : 'onChange'}
        <FlowBindingSelect
          binding={widget.events[widget.type === 'button' ? 'click' : 'change']}
          flows={project.flows}
          zh={zh}
          label={widget.type === 'button' ? 'onClick' : 'onChange'}
          onChange={(binding) => {
            const events = { ...widget.events };
            const key = widget.type === 'button' ? 'click' : 'change';
            if (binding) events[key] = binding;
            else delete events[key];
            onChange({ events });
          }}
        />
      </label>
    </div>
  );
}

function ScriptPanel({
  project,
  onChange,
  engine,
  notify,
}: {
  project: Project;
  onChange: (mutator: (p: Project) => void) => void;
  engine: RuntimeController;
  notify: (text: string, error?: boolean) => void;
}) {
  const [selected, setSelected] = useState(project.scripts[0]?.id ?? '');
  const script = project.scripts.find((s) => s.id === selected);
  const [input, setInput] = useState('0'),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  const zh = project.locale === 'zh-CN';
  const execute = async () => {
    if (!script) return;
    if (!native.isDesktop()) {
      notify(
        zh
          ? 'C 脚本需在桌面运行时执行。请运行 npm run desktop。'
          : 'C scripts require the desktop runtime: npm run desktop.',
        true,
      );
      return;
    }
    setBusy(true);
    try {
      const value: Json = JSON.parse(input);
      assertJsonValue(value);
      engine.applyProject(project);
      const r = await engine.runScript(script.id, value, project.revision);
      setResult(JSON.stringify(r, null, 2));
    } catch (error) {
      setResult(String(error));
      notify(String(error), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="editor-workbench">
      <aside className="workbench-sidebar">
        <h3>
          C {zh ? '模块' : 'MODULES'}
          <button
            className="icon-button"
            onClick={() => {
              const id = uid('script');
              onChange((p) =>
                p.scripts.push({ id, name: 'module.c', source: defaultCScript, timeoutMs: 1000 }),
              );
              setSelected(id);
            }}
          >
            <Plus size={14} />
          </button>
        </h3>
        {project.scripts.map((s) => (
          <button
            className={s.id === selected ? 'active' : ''}
            key={s.id}
            onClick={() => setSelected(s.id)}
          >
            <Code2 size={14} />
            {s.name}
          </button>
        ))}
        <div className="workbench-note">
          <strong>QuickGUI C SDK</strong>
          <p>{zh ? '真实 C · 独立进程 · 统一宿主 API' : 'Native C · isolated worker · host API'}</p>
          <code>
            qg_input_number()
            <br />
            qg_get_number(name)
            <br />
            qg_set_number(name, value)
            <br />
            qg_state_get(name)
            <br />
            qg_state_set(name, value)
            <br />
            qg_emit_number(value)
            <br />
            qg_log(message)
          </code>
        </div>
      </aside>
      <div className="script-main">
        {script ? (
          <>
            <div className="editor-toolbar">
              <input
                value={script.name}
                onChange={(e) =>
                  onChange((p) => {
                    p.scripts.find((s) => s.id === selected)!.name = e.target.value;
                  })
                }
              />
              <span className="tag">C99 / libtcc</span>
              <div className="spacer" />
              <label>
                {zh ? '输入' : 'Input'}
                <input
                  type="text"
                  aria-label={zh ? 'JSON 测试输入' : 'JSON test input'}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                />
              </label>
              <button className="button primary" disabled={busy} onClick={() => void execute()}>
                <Play size={13} />
                {busy ? '…' : zh ? '编译并测试' : 'Compile & test'}
              </button>
            </div>
            <CodeEditor
              value={script.source}
              onChange={(source) =>
                onChange((p) => {
                  p.scripts.find((s) => s.id === selected)!.source = source;
                })
              }
              language="c"
              height="100%"
            />
            <div className="script-result">
              <span>{zh ? '测试输出' : 'TEST OUTPUT'}</span>
              <pre>
                {result ||
                  (zh
                    ? '通过独立 C 工作进程编译执行；错误会定位到脚本行号。'
                    : 'Compiled and executed by an isolated C worker. Diagnostics include source locations.')}
              </pre>
            </div>
          </>
        ) : (
          <div className="empty-state">
            {zh ? '添加 C 模块开始编写逻辑' : 'Add a C module to get started'}
          </div>
        )}
      </div>
    </div>
  );
}

function DataPanel({
  project,
  onChange,
  engine,
  notify,
}: {
  project: Project;
  onChange: (mutator: (p: Project) => void) => void;
  engine: RuntimeController;
  notify: (text: string, error?: boolean) => void;
}) {
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const zh = project.locale === 'zh-CN';
  const runtimePending = snapshot.revision !== project.revision;
  const writeRuntimeValue = (id: string, value: Json) => {
    if (engine.getSnapshot().revision !== project.revision)
      throw new Error(zh ? '运行时正在更新，请稍后重试' : 'Runtime is updating. Please retry.');
    engine.setVariable(id, value);
  };
  const update = (id: string, patch: Partial<Variable>) =>
    onChange((p) =>
      Object.assign(
        p.variables.find((v) => v.id === id)!,
        patch,
      ),
    );
  return (
    <div className="data-panel">
      <header className="page-heading">
        <div>
          <span className="eyebrow">DATA MODEL</span>
          <h2>{zh ? '变量与运行状态' : 'Variables & state'}</h2>
          <p>
            {zh
              ? '类型化数据、质量状态与时间戳，供所有控件和流程共享。'
              : 'Typed values, quality and timestamps shared by widgets and flows.'}
          </p>
        </div>
        <button
          className="button primary"
          onClick={() =>
            onChange((p) => {
              const id = uid('value');
              p.variables.push({ id, name: id, type: 'number', initial: 0 });
            })
          }
        >
          <Plus size={14} />
          {zh ? '添加变量' : 'Add variable'}
        </button>
      </header>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {[
                zh ? '变量名称' : 'Name',
                zh ? '类型' : 'Type',
                zh ? '初始值' : 'Initial value',
                zh ? '运行值' : 'Runtime value',
                zh ? '单位' : 'Unit',
                zh ? '质量' : 'Quality',
                '',
              ].map((s, i) => (
                <th key={i}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {project.variables.map((v) => (
              <tr key={v.id}>
                <td>
                  <input value={v.name} onChange={(e) => update(v.id, { name: e.target.value })} />
                  <small>{v.id}</small>
                </td>
                <td>
                  <select
                    value={v.type}
                    onChange={(e) => {
                      const type = e.target.value as Variable['type'];
                      const references = variableReferences(project, v);
                      if (type !== v.type && references.length) {
                        notify(
                          `${zh ? '请先调整此变量的引用' : 'Update variable references first'}: ${references.join(', ')}`,
                          true,
                        );
                        return;
                      }
                      const apply = () =>
                        update(v.id, {
                          type,
                          initial:
                            type === 'json'
                              ? {}
                              : type === 'number'
                                ? 0
                                : type === 'boolean'
                                  ? false
                                  : '',
                          ...(type !== 'number' ? { alarm: undefined } : {}),
                        });
                      apply();
                    }}
                  >
                    <option>number</option>
                    <option>string</option>
                    <option>boolean</option>
                    <option>json</option>
                  </select>
                </td>
                <td>
                  {v.type === 'json' ? (
                    <JsonValueField
                      label={`initial ${v.name}`}
                      value={v.initial}
                      onCommit={(initial) => update(v.id, { initial })}
                    />
                  ) : v.type === 'boolean' ? (
                    <input
                      type="checkbox"
                      checked={Boolean(v.initial)}
                      onChange={(e) => update(v.id, { initial: e.target.checked })}
                    />
                  ) : (
                    <input
                      type={v.type === 'number' ? 'number' : 'text'}
                      value={String(v.initial)}
                      onChange={(e) =>
                        update(v.id, {
                          initial: v.type === 'number' ? Number(e.target.value) : e.target.value,
                        })
                      }
                    />
                  )}
                </td>
                <td>
                  {v.type === 'json' ? (
                    <JsonValueField
                      label={`runtime ${v.name}`}
                      value={snapshot.values[v.id]?.value ?? null}
                      disabled={v.readOnly || runtimePending || !snapshot.values[v.id]}
                      onCommit={(value) => writeRuntimeValue(v.id, value)}
                    />
                  ) : v.type === 'boolean' ? (
                    <input
                      type="checkbox"
                      checked={Boolean(snapshot.values[v.id]?.value)}
                      disabled={v.readOnly || runtimePending || !snapshot.values[v.id]}
                      onChange={(e) => {
                        try {
                          writeRuntimeValue(v.id, e.target.checked);
                        } catch (error) {
                          notify(String(error), true);
                        }
                      }}
                    />
                  ) : (
                    <input
                      aria-label={`runtime ${v.name}`}
                      disabled={v.readOnly || runtimePending || !snapshot.values[v.id]}
                      type={v.type === 'number' ? 'number' : 'text'}
                      value={String(snapshot.values[v.id]?.value ?? '')}
                      onChange={(e) => {
                        try {
                          writeRuntimeValue(
                            v.id,
                            v.type === 'number' ? Number(e.target.value) : e.target.value,
                          );
                        } catch (error) {
                          notify(String(error), true);
                        }
                      }}
                    />
                  )}
                </td>
                <td>
                  <input
                    value={v.unit ?? ''}
                    onChange={(e) => update(v.id, { unit: e.target.value })}
                  />
                </td>
                <td>
                  <span className="quality-tag">{snapshot.values[v.id]?.quality ?? '—'}</span>
                </td>
                <td>
                  <button
                    className="icon-button"
                    title="Delete"
                    onClick={() => {
                      if (variableReferences(project, v).length)
                        return notify(
                          zh
                            ? '请先移除该变量的绑定和节点引用'
                            : 'Remove bindings and node references first',
                          true,
                        );
                      onChange((p) => {
                        p.variables = p.variables.filter((x) => x.id !== v.id);
                      });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <HistoryPanel project={project} engine={engine} onChange={onChange} />
    </div>
  );
}
