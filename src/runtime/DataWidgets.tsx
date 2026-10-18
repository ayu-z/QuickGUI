import { useEffect, useRef, useState } from 'react';
import type { HistoryRangeResult, Json, Project } from '../core/types';
import { getJsonPath, type JsonPath } from '../core/widgetDefinitions';

export interface ChartSeries {
  id: string;
  name: string;
  value: number | null;
  color: string;
  visible: boolean;
  variableId?: string;
}
export interface ChartSample {
  timestamp: number;
  values: Record<string, number | null>;
}
export interface TableColumn {
  id: string;
  title: string;
  path: JsonPath;
  width?: number;
  align: 'left' | 'center' | 'right';
  format?: string;
}
const object = (value: Json): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const numeric = (value: Json | undefined, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
const stringify = (value: Json | undefined): string =>
  value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const themeColor = (value: string, project: Project) =>
  value.startsWith('$') ? (project.theme.tokens[value.slice(1)] ?? 'currentColor') : value;
export function chartSeries(props: Record<string, Json>): ChartSeries[] {
  return (Array.isArray(props.series) ? props.series : []).slice(0, 16).map((raw, index) => {
    const series = object(raw);
    return {
      id: String(series.id ?? `series_${index}`),
      name: String(series.name ?? `Series ${index + 1}`),
      value:
        typeof series.value === 'number' && Number.isFinite(series.value) ? series.value : null,
      color: String(series.color ?? '$color.primary'),
      visible: series.visible !== false,
      ...(typeof series.variableId === 'string' ? { variableId: series.variableId } : {}),
    };
  });
}
export function appendChartSample(
  samples: ChartSample[],
  series: ChartSeries[],
  timestamp: number,
  maxPoints: number,
): ChartSample[] {
  return [
    ...samples,
    { timestamp, values: Object.fromEntries(series.map((item) => [item.id, item.value])) },
  ].slice(-Math.max(2, Math.min(10000, Math.floor(maxPoints))));
}
/** Null and bad-quality samples split paths instead of drawing fabricated values. */
export function chartPath(
  points: { timestamp: number; value: number | null }[],
  min: number,
  max: number,
  from: number,
  to: number,
): string {
  let drawing = false;
  return points
    .map((point) => {
      if (point.value === null || !Number.isFinite(point.value)) {
        drawing = false;
        return '';
      }
      const x = Math.max(0, Math.min(1, (point.timestamp - from) / Math.max(1, to - from))) * 480;
      const y =
        130 -
        Math.max(0, Math.min(1, (point.value - min) / Math.max(Number.EPSILON, max - min))) * 120;
      const command = `${drawing ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
      drawing = true;
      return command;
    })
    .filter(Boolean)
    .join(' ');
}
export function ChartWidget({
  props,
  project,
  interactive,
}: {
  props: Record<string, Json>;
  project: Project;
  interactive: boolean;
}) {
  const series = chartSeries(props),
    latest = useRef(series);
  latest.current = series;
  const interval = numeric(props.sampleInterval, 250, 50, 60000),
    maxPoints = numeric(props.maxPoints, 600, 2, 10000);
  const identity = series.map((item) => item.id).join('\u0000');
  const [samples, setSamples] = useState<ChartSample[]>(() =>
    appendChartSample([], series, Date.now(), maxPoints),
  );
  const [history, setHistory] = useState<HistoryRangeResult | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [refresh, setRefresh] = useState(0);
  const historyMode = props.mode === 'history';
  useEffect(() => {
    setSamples(appendChartSample([], latest.current, Date.now(), maxPoints));
    if (historyMode || !interactive) return;
    const timer = setInterval(
      () =>
        setSamples((previous) =>
          appendChartSample(previous, latest.current, Date.now(), maxPoints),
        ),
      interval,
    );
    return () => clearInterval(timer);
  }, [identity, interval, maxPoints, historyMode, interactive, project.id]);
  const variables = series.map((item) => item.variableId ?? '').join('\u0000');
  const duration = numeric(props.historyDuration, 3600, 1, 2592000);
  const fromSetting = props.historyFrom,
    toSetting = props.historyTo,
    aggregation = props.historyAggregation ?? 'avg';
  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setError('');
    if (!historyMode) return;
    if (!interactive) {
      setError(
        project.locale === 'zh-CN'
          ? '运行预览时读取 SQLite 历史'
          : 'SQLite history is loaded when preview runs',
      );
      return;
    }
    const ids = [
      ...new Set(latest.current.map((item) => item.variableId).filter((id): id is string => !!id)),
    ];
    if (!ids.length) {
      setError(
        project.locale === 'zh-CN'
          ? '请为曲线选择历史变量'
          : 'Choose a history variable for each series',
      );
      return;
    }
    setLoading(true);
    void import('../native/bridge')
      .then(async (native) => {
        if (!native.isDesktop())
          throw new Error(
            project.locale === 'zh-CN'
              ? '浏览器无法读取 SQLite 历史，请在桌面运行时打开。'
              : 'SQLite history is unavailable in the browser. Open the desktop runtime.',
          );
        const toMs = typeof toSetting === 'number' && toSetting > 0 ? toSetting : Date.now();
        const fromMs =
          typeof fromSetting === 'number' && fromSetting > 0 ? fromSetting : toMs - duration * 1000;
        if (fromMs >= toMs) throw new Error('History start must precede end');
        const mode = ['raw', 'avg', 'min', 'max', 'last'].includes(String(aggregation))
          ? (aggregation as 'raw' | 'avg' | 'min' | 'max' | 'last')
          : 'avg';
        const historyLimit = Math.min(maxPoints, 2000, Math.floor(20000 / ids.length));
        const result = await native.queryHistoryRange({
          variableIds: ids,
          fromMs,
          toMs,
          aggregation: mode,
          maxPointsPerSeries: historyLimit,
          ...(mode === 'raw'
            ? {}
            : {
                bucketMs: Math.max(1, Math.ceil((toMs - fromMs) / Math.max(1, historyLimit - 1))),
              }),
        });
        if (cancelled) return;
        if (result.projectId && result.projectId !== project.id)
          throw new Error('History belongs to a different project');
        setHistory(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    historyMode,
    interactive,
    variables,
    duration,
    fromSetting,
    toSetting,
    aggregation,
    maxPoints,
    refresh,
    project.id,
    project.locale,
  ]);
  const min = numeric(props.min, 0, -Number.MAX_VALUE, Number.MAX_VALUE),
    max = numeric(props.max, 100, min + Number.EPSILON, Number.MAX_VALUE);
  const from = historyMode ? (history?.fromMs ?? 0) : (samples[0]?.timestamp ?? 0);
  const to = historyMode
    ? (history?.toMs ?? 1)
    : Math.max(from + interval, samples.at(-1)?.timestamp ?? from + 1);
  const displayed = interactive ? samples : appendChartSample([], series, Date.now(), maxPoints);
  const hasHistory = history?.series.some((item) =>
    item.points.some((point) => point.value !== null),
  );
  return (
    <div className="qg-data-chart">
      {props.showLegend !== false && (
        <div className="qg-chart-legend">
          {series
            .filter((item) => item.visible)
            .map((item) => (
              <span key={item.id}>
                <i style={{ background: themeColor(item.color, project) }} />
                {item.name}
              </span>
            ))}
        </div>
      )}
      {error ? (
        <div className="qg-data-message" role="status">
          {error}
        </div>
      ) : (
        <svg
          viewBox="0 0 530 170"
          preserveAspectRatio="none"
          role="img"
          aria-label={project.locale === 'zh-CN' ? '趋势图' : 'Trend chart'}
        >
          <g transform="translate(42,8)">
            {[0, 1, 2, 3, 4].map((tick) => (
              <g key={tick}>
                {props.showGrid !== false && (
                  <line
                    x1="0"
                    y1={10 + tick * 30}
                    x2="480"
                    y2={10 + tick * 30}
                    stroke="var(--qg-border)"
                    strokeDasharray="3 4"
                  />
                )}
                <text x="-7" y={14 + tick * 30} textAnchor="end" fill="currentColor" fontSize="10">
                  {Number((max - ((max - min) * tick) / 4).toPrecision(5))}
                </text>
              </g>
            ))}
            {series
              .filter((item) => item.visible)
              .map((item) => {
                const points = historyMode
                  ? (
                      history?.series.find((entry) => entry.variableId === item.variableId)
                        ?.points ?? []
                    ).map((point) => ({
                      timestamp: point.timestamp,
                      value: point.quality === 'bad' ? null : point.value,
                    }))
                  : displayed.map((sample) => ({
                      timestamp: sample.timestamp,
                      value: sample.values[item.id] ?? null,
                    }));
                return (
                  <path
                    key={item.id}
                    d={chartPath(points, min, max, from, to)}
                    fill="none"
                    stroke={themeColor(item.color, project)}
                    strokeWidth={numeric(props.lineWidth, 2, 0.5, 20)}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            <text x="0" y="151" fill="currentColor" fontSize="10">
              {historyMode ? new Date(from).toLocaleTimeString() : `${displayed.length} samples`}
            </text>
            <text x="480" y="151" textAnchor="end" fill="currentColor" fontSize="10">
              {String(props.unit ?? '')}{' '}
              {historyMode ? new Date(to).toLocaleTimeString() : `${interval} ms`}
            </text>
          </g>
        </svg>
      )}
      {historyMode && (
        <div className="qg-chart-history-status">
          <span>
            {loading
              ? '…'
              : history && !hasHistory
                ? project.locale === 'zh-CN'
                  ? '此时间范围没有历史数据'
                  : 'No history in this range'
                : history?.series.some((entry) => entry.truncated)
                  ? project.locale === 'zh-CN'
                    ? '数据已按点数上限截断'
                    : 'History truncated to point limit'
                  : ''}
          </span>
          <button disabled={!interactive || loading} onClick={() => setRefresh((n) => n + 1)}>
            {project.locale === 'zh-CN' ? '刷新' : 'Refresh'}
          </button>
        </div>
      )}
    </div>
  );
}

export function tableColumns(props: Record<string, Json>, rows: Json[]): TableColumn[] {
  const columns = Array.isArray(props.columns) ? props.columns : [];
  if (!columns.length) {
    const first = rows[0];
    const keys = first && typeof first === 'object' ? Object.keys(first) : ['value'];
    return keys.map((key) => ({
      id: key,
      title: key,
      path: first && typeof first === 'object' ? [Array.isArray(first) ? Number(key) : key] : [],
      align: 'left',
    }));
  }
  return columns.map((raw, index) => {
    const column = object(raw);
    return {
      id: String(column.id ?? index),
      title: String(column.title ?? column.id ?? index + 1),
      path: Array.isArray(column.path) ? (column.path as JsonPath) : [],
      width: typeof column.width === 'number' && column.width > 0 ? column.width : undefined,
      align: ['left', 'center', 'right'].includes(String(column.align))
        ? (column.align as TableColumn['align'])
        : 'left',
      format: typeof column.format === 'string' ? column.format : undefined,
    };
  });
}
export function sortTableRows(
  rows: Json[],
  column?: TableColumn,
  direction: 'asc' | 'desc' = 'asc',
): { row: Json; index: number }[] {
  const result = rows.map((row, index) => ({ row, index }));
  if (!column) return result;
  return result.sort((a, b) => {
    const left = getJsonPath(a.row, column.path),
      right = getJsonPath(b.row, column.path);
    const compared =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : stringify(left).localeCompare(stringify(right), undefined, { numeric: true });
    return compared === 0 ? a.index - b.index : compared * (direction === 'asc' ? 1 : -1);
  });
}
export function tableData(props: Record<string, Json>) {
  const sourceRows = Array.isArray(props.rows) ? props.rows : [];
  const headerOffset = props.headerFromFirstRow === true ? 1 : 0;
  const rows = headerOffset
    ? sourceRows.slice(1).map((row) => (Array.isArray(row) ? row : [row]))
    : sourceRows;
  const header = headerOffset
    ? Array.isArray(sourceRows[0])
      ? sourceRows[0]
      : sourceRows.length
        ? [sourceRows[0]]
        : []
    : [];
  const columns = tableColumns(props, rows).map((column) =>
    headerOffset && typeof column.path[0] === 'number'
      ? {
          ...column,
          title:
            typeof header[column.path[0]] === 'number'
              ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(
                  header[column.path[0]] as number,
                )
              : stringify(header[column.path[0]]),
        }
      : column,
  );
  return { sourceRows, headerOffset, rows, columns };
}
export function TableWidget({
  props,
  interactive,
  onEvent,
  locale,
}: {
  props: Record<string, Json>;
  interactive: boolean;
  onEvent: (event: string, payload: Json) => void;
  locale: string;
}) {
  const { sourceRows, headerOffset, rows, columns } = tableData(props);
  const [sort, setSort] = useState<{ id: string; direction: 'asc' | 'desc' } | null>(null),
    [page, setPage] = useState(0);
  const pageSize = Math.floor(numeric(props.pageSize, 20, 1, 1000)),
    pages = Math.max(1, Math.ceil(rows.length / pageSize)),
    current = Math.min(page, pages - 1);
  const sorted = sortTableRows(
    rows,
    props.sortable === false ? undefined : columns.find((item) => item.id === sort?.id),
    sort?.direction,
  );
  const shown = sorted.slice(current * pageSize, (current + 1) * pageSize);
  return (
    <div className={`qg-data-table ${props.striped !== false ? 'striped' : ''}`}>
      <div className="qg-table-scroll">
        <table>
          <colgroup>
            {columns.map((column) => (
              <col key={column.id} style={{ width: column.width }} />
            ))}
          </colgroup>
          {props.headerVisible !== false && (
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.id}
                    style={{ textAlign: column.align }}
                    aria-sort={
                      sort?.id === column.id
                        ? sort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    {props.sortable !== false ? (
                      <button
                        disabled={!interactive}
                        onClick={() => {
                          setSort({
                            id: column.id,
                            direction:
                              sort?.id === column.id && sort.direction === 'asc' ? 'desc' : 'asc',
                          });
                          setPage(0);
                        }}
                      >
                        {column.title}
                        {sort?.id === column.id ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                    ) : (
                      column.title
                    )}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {shown.map(({ row, index }) => (
              <tr
                key={index}
                tabIndex={interactive ? 0 : -1}
                style={{ height: numeric(props.rowHeight, 36, 16, 200) }}
                onClick={() => {
                  if (interactive)
                    onEvent('rowClick', {
                      row: sourceRows[index + headerOffset],
                      index: index + headerOffset,
                    });
                }}
                onKeyDown={(event) => {
                  if (interactive && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onEvent('rowClick', {
                      row: sourceRows[index + headerOffset],
                      index: index + headerOffset,
                    });
                  }
                }}
              >
                {columns.map((column) => {
                  const value = getJsonPath(row, column.path);
                  return (
                    <td key={column.id} style={{ textAlign: column.align }}>
                      {column.format === 'number' && typeof value === 'number'
                        ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(
                            value,
                          )
                        : stringify(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="qg-data-message">
            {String(props.emptyText ?? (locale === 'zh-CN' ? '暂无数据' : 'No data'))}
          </div>
        )}
      </div>
      <div className="qg-table-pagination">
        <button
          disabled={!interactive || current === 0}
          onClick={() => setPage(current - 1)}
          aria-label={locale === 'zh-CN' ? '上一页' : 'Previous page'}
        >
          ‹
        </button>
        <span>
          {current + 1} / {pages} · {rows.length}
        </span>
        <button
          disabled={!interactive || current >= pages - 1}
          onClick={() => setPage(current + 1)}
          aria-label={locale === 'zh-CN' ? '下一页' : 'Next page'}
        >
          ›
        </button>
      </div>
    </div>
  );
}
