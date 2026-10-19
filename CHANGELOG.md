# 变动日志

## 2026-10-20 — 独立亮暗配色与资源页空间优化

- 应用外观按明确需求改为“索引／亮色／暗色”三列，每个方案单元格包含色块与颜色值，支持分别编辑和原子新增双色令牌。两套颜色分别保存，编辑非当前列不改变有效颜色或窗口，切换选择已保存方案，不重置已编辑值；主题匹配的主/附窗口背景跟随切换，字面颜色、自定义背景和独立组件资源保留。
- v5主题增加可选 `palettes.light/dark`，沿用 `tokens` 保存当前有效颜色，设计、预览与独立运行器共用有效值。旧工程只读不新增字段或变脏，首次编辑/切换才生成方案；当前颜色保留，另一套内置色取对应默认值，自定义键继承原值，不补入稀疏旧工程缺失的键。`system` 保持原有效色在暗色列，不引入新的系统自动切换行为。
- 工程、资源作用域和组件包共用严格主题校验，要求两套颜色与有效令牌键集合一致，当前方案值与有效值一致；缺失或不一致时拒绝导入，不静默改写。双色字段需要支持它的新版设计器，旧版严格校验会拒绝未知字段；兼容性说明已更新，不承诺旧版向前兼容。
- 两页去掉窄卡片、大标题、常驻长说明与重复滚动层，改为满宽剩余空间表格、紧凑新增工具栏和默认收起的使用说明，保留固定表头、固定索引、32px输入及原多语言展开规则。配置页不占用运行日志空间，不改变界面/流程页的日志开关偏好；构建时仍可显示实时输出并按实际可见状态定位进度。
- 修改 `src/core/types.ts`、`src/core/themePresets.ts`、`src/core/validation.ts`、`src/core/componentPackage.ts`、`src/App.tsx`、`src/panels/AppearancePanel.tsx`、`src/panels/appearance.css`、`src/panels/TranslationsPanel.tsx`、`src/panels/translations.css`、`src/styles.css`；移除原外观卡片与色块预设的未使用样式，无源文件删除或重命名。修改 `tests/theme-presets.test.ts`、`tests/e2e/appearance-colors.spec.ts`、`tests/e2e/project-theme.spec.ts`、`tests/e2e/translations.spec.ts`，新增 `tests/theme-palettes.test.ts`；修改 `README.md`、`docs/architecture.md`、`docs/project-compatibility.md` 和本文件。无新增依赖。
- 新增10项核心回归，覆盖3种旧模式只读、稀疏键、双方案独立编辑与反复切换、窗口背景、撤销、严格校验、工程/组件包ZIP和跨工程资源往返。两页专项扩为15项，覆盖新增双色单次撤销、非当前列不改当前画面、画布/预览/导出/刷新、旧工程与自定义色保留、日志偏好及宽窄亮暗布局；1100×700与1440×920表格宽度至少占工作区90%、高度至少占资源页60%且分别不少于340/480px，完整可见行分别至少6/10行。首轮14/15通过，剩余一项因颜色选择器也映射为textbox而误计数，已改为按类型及精确标签严格验证每格1个色块和1个文本值，不改产品迎合定位，也不放宽超时。
- 最终 `npm run check` 的TypeScript及285项单测、隔离Chromium全量89/89和WebKit专项15/15通过，正式测试配置与超时保持不变；已目视核对紧凑双色表及多语言表的宽窄亮暗截图。`npx tauri build --debug --bundles app` 的前置生产构建与本机应用打包成功，更新 `target/debug/bundle/macos/QuickGUI.app`（78.01 MiB）。实际命令行导出带双色方案的独立源码，逐字段确认两套配色及活动令牌完整保留，并在导出目录通过前端构建；此构建复用本机已有依赖，不视为全新环境安装或独立原生发布验收。
- Prettier与Git差异检查通过，保留既有Monaco体积与桥接混合导入提示。`cargo test --workspace` 仍受未改动的 `crates/quickgui-engine/src/serial_demo_test.rs:154` E0502阻断，未记为通过；无Rust业务、C SDK、进程协议或编译路径变更，未重复C/AOT专项。报告、截图、导出源码和应用包按生成物处理；用户 `QuickGUI_Icons/` 未修改或暂存。

## 2026-10-20 — 紧凑翻译输入、双语并排与三列颜色编辑

- 翻译改为32px单行输入，正文行高约45px，移除“恢复回退”按钮及对应样式。已有缺省与显式空字符串语义保持，旧工程多行文本仅折叠显示，未经用户编辑不会重写原文。
- 一至两种语言始终全部展开，不再显示折叠箭头；双语时索引列与两种语言在1100px窗口内并排显示。三种及以上保留单列互斥展开或全部收起，新增、删除、撤销重做自动切换布局；保留展开偏好供撤销恢复。补充保留索引名称校验，避免新增或重命名为工程校验无法往返的 `__proto__`；其他普通索引安全保存。
- 应用外观改为“索引／颜色／颜色值”三列表格，正文行高46px，输入32px，色块与值双向同步。支持通过 `brand`、`color.brand` 或 `$color.brand` 添加颜色，规范化后写入已有令牌；空、非法及重复索引拒绝写入，新增可单步撤销，亮暗预设保留自定义颜色，画布、预览和导出共用令牌。
- 修改 `src/panels/TranslationsPanel.tsx`、`src/panels/translations.css`、`src/panels/AppearancePanel.tsx`、`src/styles.css`、`tests/e2e/translations.spec.ts`、`README.md`、`docs/architecture.md` 和本文件；新增 `src/panels/appearance.css`、`tests/e2e/appearance-colors.spec.ts`。移除全局旧颜色列表专属样式，由新颜色表样式替代；无源文件删除或重命名，无依赖或工程格式变更。
- 语言回归由4项扩展为6项，覆盖单语/空语、2→3→2与撤销、紧凑双语可视范围、32px输入、旧多行原文及空文本往返、保留名称拒绝与普通特殊索引、运行时语言切换、真实纵横滚轮和焦点恢复。新增3项颜色回归，覆盖三列/行高、增色与撤销重做、重复拒绝、编辑同步、自定义令牌的亮暗预设保留、画布/预览/导出/刷新与紧凑亮暗截图。
- 首轮定向11项中10项通过，长表聚焦检查失败；依据trace定位共用滚动内边距会让固定索引定位意外复位横向位置。改为仅展开列使用滚动外边距，并在输入框实际获得焦点时显示整列；不锁定手动横向浏览。保留完整列可见矩形断言，更新长表回归为真实滚轮与实际焦点切换，专项复跑通过，未放宽超时。
- 最终 `npm run check` 的TypeScript与275项单测、隔离Chromium全量85/85及WebKit外观/主题/多语言专项11/11通过，测试配置与超时保持不变，已目视核对紧凑双语及三列颜色表的亮暗截图；`npx tauri build --debug --bundles app` 的前置 `npm run build` 及桌面打包成功，更新 `target/debug/bundle/macos/QuickGUI.app`（78.00 MiB）。Prettier与Git差异检查通过，保留既有Monaco体积与桥接混合导入提示；报告、截图、隔离副本与应用包均按生成物处理。
- `cargo test --workspace` 仍被既有 `crates/quickgui-engine/src/serial_demo_test.rs:154` 的E0502借用冲突阻断，该文件未改动，未记为通过。无Rust业务、C SDK、进程协议或编译路径变更，未重复C/AOT专项，不将浏览器回归描述为原生多平台验收。用户 `QuickGUI_Icons/` 保持未修改、未暂存。

## 2026-10-20 — 拆分应用外观与表格式多语言工作区

- 工作空间导航改为“界面 → 应用外观 → 多语言 → 流程 → C脚本 → 数据 → 连接”，移除顶部合并设置入口。应用外观作为独立页面保留工程亮暗预设、令牌颜色/文本编辑及主窗口背景；设计器主题仍由原工具栏按钮独立切换。导航支持窄窗口滚动，保持右侧撤销等操作可用。
- 多语言使用普通表格，首列为固定索引（控件通过 `@key` 引用），第二列起每列对应一种语言。支持新增/删除语言、增删索引、跨语言安全重命名及文本编辑；语言列可全部收起，同一时刻最多展开一列，展开时自动滚动并避让固定索引，保持完整编辑区域可见。
- 重复或空索引/语言拒绝写入，索引回车/失焦保存、Esc取消，组合输入选词不提前提交；翻译即时进入工程历史与自动保存。缺失翻译与显式空字符串保留区别，“恢复回退”仅取消当前语言的单个翻译覆盖；新增语言不批量补齐旧字典，导入的其他语言/索引保留。重命名索引需同步修改控件引用，界面中已说明。
- 删除 `src/panels/ProjectSettings.tsx`，原因是合并弹窗被两个工作区替代；其中外观内容由旧路径迁至新增的 `src/panels/AppearancePanel.tsx`，同时移除弹窗与JSON翻译编辑，补充输入可访问名称。另新增 `src/panels/TranslationsPanel.tsx`、`src/panels/translations.css`、`tests/e2e/translations.spec.ts`；修改 `src/App.tsx`、`src/core/i18n.ts`、`src/core/store.ts`、`src/styles.css`、`tests/e2e/project-theme.spec.ts`、`README.md`、`docs/architecture.md` 和本文件。Git记录为新增/删除，无其他删除或重命名。
- 新增4项端到端回归，覆盖导航分离、首列及语言列结构、展开互斥与全部收起、多语言增删/编辑、重复拒绝、索引重命名/删除与撤销、受控组合输入事件、空字符串/缺省回退、自动保存/刷新/导出导入、运行时locale变量切换及1100×700紧凑布局。主题回归改用新页面入口，保留原有画布、预览、导出与自定义资源断言。
- 验证：最终 `npm run check` 的TypeScript与275项单测、`npm run build`（桌面打包前置命令）、隔离Chromium全量80/80及WebKit外观/多语言专项6/6通过，沿用正式测试配置与超时；已目视核对应用外观及紧凑表格暗亮截图，修复初轮发现的右侧列展开后仅部分可见问题。`npx tauri build --debug --bundles app` 成功，更新 `target/debug/bundle/macos/QuickGUI.app`（78.00 MiB）；Prettier及Git差异检查通过。报告、截图、隔离依赖与应用包按生成物处理，不作为原生跨平台交互验收。
- `cargo test --workspace` 仍被未改动的 `crates/quickgui-engine/src/serial_demo_test.rs:154` 既有E0502借用冲突阻断，未记为通过。无工程格式、依赖、Rust业务、C SDK、进程协议或编译路径变更，未重复C/AOT专项；保留既有Monaco大包与桥接混合导入提示。用户 `QuickGUI_Icons/` 未修改、未暂存。

## 2026-10-20 — 隐藏设计器原生标题文字

- 将设计器主窗口 `title` 置空，并启用macOS `hiddenTitle`，移除系统标题栏中的QuickGUI文字；保留系统窗口装饰、应用名称和设计器内部品牌。工程窗口仍使用各自的标题配置。
- 修改 `src-tauri/tauri.conf.json` 和本文件；无源文件新增、删除或重命名，无依赖、工程格式、Rust业务或C执行路径变更。
- 验证：依据本机Tauri配置schema核对字段，`npx tauri build --debug --bundles app` 成功（78.00 MiB）；重新载入新构建进程，macOS原生可访问性树确认设计器窗口标题为空，工程预览窗口仍为“泵站控制面板”。命令行实际调用 `runtimeConfig`，断言导出应用保留工程标题且未继承 `hiddenTitle`；原生导出器的新窗口构造路径经源码检查，不将其描述为运行验收。未执行Windows原生目视验证。
- 集成前端类型检查、275项单测、构建、Chromium76项及WebKit专项6项通过，Git差异与配置格式检查通过。Rust全量仍因既有 `serial_demo_test.rs:154` E0502阻断，详见同日记录；未重复C/AOT专项。生成应用包及验证报告不纳入源码提交。

## 2026-10-20 — 工程界面一键亮暗主题

- 在“应用外观与多语言 → 主题令牌”增加工程界面“一键亮色／一键暗色”，一次事务更新主题模式、9个内置颜色令牌，以及匹配原主题背景色的主/附加窗口背景，支持单步撤销重做、自动保存和工程往返。
- 保留自定义令牌键、控件固定颜色、自定义窗口背景、独立组件资源与自定义React源码；设计器外观独立控制。共用渲染器为明确亮/暗主题设置 `color-scheme`，画布控件、预览及导出运行器中的原生表单控件不再继承相反的设计器主题；system模式沿用既有继承行为。
- 新增 `src/core/themePresets.ts`、`tests/theme-presets.test.ts`、`tests/e2e/project-theme.spec.ts`；修改 `src/panels/ProjectSettings.tsx`、`src/runtime/WidgetRenderer.tsx`、`src/styles.css`、`README.md`和本文件。无源文件删除或重命名，无依赖、工程格式、C SDK、进程协议或编译路径变更。
- 验证：新增5项单测和2项浏览器回归，覆盖示例/多窗口、保留自定义颜色与资源、幂等、撤销重做、设计器主题独立、反向主题下的原生控件配色、预览、导出与刷新恢复。集成 `npm run check` 的TypeScript和275项单测、`npm run build`、隔离Chromium全量76/76及WebKit主题/选择专项6/6通过，未放宽测试超时；Prettier与Git差异检查通过。
- `npx tauri build --debug --bundles app` 成功，生成 `target/debug/bundle/macos/QuickGUI.app`（78.00 MiB）；报告、隔离脚本、依赖副本及应用包均按生成物处理。保留既有Monaco大包与桥接混合导入提示。Rust全量因同日属性面板记录中的既有E0502阻断，未重复C/AOT专项；不将浏览器回归描述为原生多平台验收。

## 2026-10-20 — 取消控件选择后默认显示窗口属性

- 界面编辑点击空白处、Escape、清空选择、删除最后一个选中控件或撤销移除该控件时，右侧自动显示当前窗口属性。保留有效多选；属性输入框失焦不取消控件选择，不清除无效 CODE 草稿。空工程和空附加窗口直接显示自身窗口属性。
- 模块定义内取消选择仍保留模块编辑上下文，窗口属性读写实际工程窗口，避免修改模块投影。工程变化后清理失效选择，属性面板与有效主选保持一致。
- 修改 `src/App.tsx`、`src/core/store.ts`；新增 `tests/selection-inspector.test.ts`、`tests/e2e/selection-inspector.spec.ts`；更新本文件。无源文件删除、重命名、依赖或工程格式变更，无 Rust 业务、C SDK、协议或编译路径变更。
- 验证：新增8项单测、4项浏览器回归，覆盖空白点击、Escape、删除与撤销重做、输入失焦、多选、模块及附加窗口。集成 `npm run check` 的 TypeScript 和275项单测、`npm run build`、隔离 Chromium 全量76/76、WebKit主题/选择专项6/6均通过；沿用正式测试配置和超时。Prettier及Git差异检查通过；报告与隔离脚本按生成物处理。
- `cargo test --workspace` 仍被既有 `crates/quickgui-engine/src/serial_demo_test.rs:154` 的 E0502借用冲突阻断，该文件未改动；未将Rust检查记为通过。未重复C/AOT专项，执行路径未改变。用户 `QuickGUI_Icons/` 未修改、未纳入提交。

## 2026-10-19 — 修复流程页滚动与画布尺寸初始化

- 针对左侧无法滚动、中央流程不可见的反馈，移除中心面板和流程宿主两层 display:contents，改用真实定位容器中的三栏 Grid。保留224/304与190/280侧栏宽度，日志仍只占中央底部，通过共享CSS变量预留148px或0px，开关不触发父属性表单重绘。
- 左侧明确设置43px/auto/minmax(0,1fr)行与纵向滚动、禁止横向溢出；右侧属性正文也使用明确的可收缩滚动行。中央使用43px/minmax(0,1fr)/29px行，React Flow绝对填满实际视口，消除多层flex百分比高度与透明宿主的尺寸依赖。
- 首次适应改为等待节点测量和真实视口正尺寸，核对内部尺寸一致后执行一次，忽略隐藏期间的500px回退尺寸；后续窗口大小变化保持用户手动缩放，不反复重置视图。
- 修改 `src/App.tsx`、`src/designer/FlowCanvas.tsx`、`src/designer/designer.css`、`src/styles.css`、`tests/e2e/flow-layout.spec.ts`、`docs/architecture.md` 和本文件；无新增、删除、重命名、依赖或工程格式变更，无原生业务、通信、C SDK/协议/编译路径变更。用户QuickGUI_Icons/不纳入提交，隔离依赖、脚本、报告和应用包按生成物处理。
- 新增1440×920、1100×700两档实际滚轮滚到底并鼠标点击末尾节点的回归，断言节点进入真实画布且可命中，覆盖日志开关、页签/流程切换；增加隐藏→显示首fit及手动缩放后resize保持回归。现用Chromium/WebKit基线未复现用户完整症状，但核实旧透明宿主无自身尺寸、首次零尺寸存在提前适应风险；本次按兼容性风险修正，不把未复现描述成已复现。
- 验证：`npm run check` 的TypeScript与262项单测、生产构建通过；隔离Chromium全量70/70、WebKit布局专项9/9通过，包含拖动性能与真实滚动/可见性检查。新增补测初期修正了“运行日志”按钮定位和Node.remove类型错误，之后检查与构建通过；测试超时和正式配置未放宽。报告分别在忽略的 artifacts/isolated-e2e 与 artifacts/isolated-e2e-webkit。
- `npx tauri build --debug --bundles app` 通过，更新 `target/debug/bundle/macos/QuickGUI.app`（78.00 MiB）。实际重开该包，确认原生WKWebView中的流程节点可见、适应画布可用，节点库能滚动到USB通信并往返；验证期间工程仍为rev0、未新增节点或执行设备通信。该原生目视/交互检查仅覆盖本机窗口，不扩展为Windows/其他macOS或设备性能验收。
- Prettier与Git差异检查通过。Rust全量及C/AOT专项未重复：Rust测试仍有先前记录的 serial_demo_test.rs:154 E0502基线阻碍，本次未修改Rust或C执行路径；保留既有Monaco大包和桥接混合导入提示。

## 2026-10-19 — 流程页统一界面编辑布局

- 流程页采用与界面页一致的三栏工作区：224px 流程选择/节点库、中间画布、304px 属性栏；1200px 及以下统一为 190px/280px。两侧跨越日志区，控制台仅在画布中央列；取消原全宽横向节点条，画布获得更多垂直空间。
- 左栏复用组件库的搜索、分组、计数与双列卡片，支持中英文/节点类型搜索和清空；保留19个节点添加入口、串口/USB双FB预设和原有流程选择/新增行为。右栏复用属性面板标题、字号、16px间距和独立滚动正文；选中节点与流程常规配置均可编辑，空工程有创建引导。
- 中间复用43px canvas-heading及29px状态栏，提供节点/连线数、缩放百分比、100%重置、适应、网格与16px吸附开关；取代底部悬浮缩放控件。React Flow显式提供独立上下文，视图工具和运行高亮继续与父属性表单隔离。设计器亮暗主题传入流程画布，工程主题保持独立，视图操作不产生工程变更。
- 修改 `src/App.tsx`、`src/designer/FlowEditor.tsx`、`src/designer/FlowCanvas.tsx`、`src/designer/designer.css`、`src/styles.css`、`docs/architecture.md`；新增 `tests/e2e/flow-layout.spec.ts`，与本日志一并提交。无删除、重命名、依赖、模型、通信或原生源文件变更；保留未跟踪的用户 QuickGUI_Icons/，生成物不提交。
- 新增6项布局回归：1440/1100与亮暗四组合对齐界面页侧栏、标题、状态与控制台边界，工程主题相反时仍采用设计器外观；覆盖节点搜索/清空/添加、键盘选流程、属性正文滚动及固定标题、顶部缩放/适应/网格/吸附操作且模型不变。已目视核验亮暗/宽窄截图；报告与截图位于忽略的 artifacts/isolated-e2e。
- 初轮布局检查发现CSS替换误匹配共享选择器，已恢复公共样式并将修改限定在流程专属区块；Mac无头浏览器原生下拉菜单使用键盘字母定位完成自动化，未放宽检查或超时。最终布局专项6/6、TypeScript与262项单测及生产构建通过；`node artifacts/run-isolated-e2e.mjs` 最终67/67 Chromium E2E一次全部通过（1.5分钟），包含前次3项拖动/高亮性能回归；正式用例和超时不变，原1420开发服务保留。`npx tauri build --debug --bundles app` 通过，更新 `target/debug/bundle/macos/QuickGUI.app`（78.00 MiB）。Prettier与Git差异检查通过，保留既有Monaco大包和桥接混合导入提示。
- Rust全量测试本轮未重复：上一逻辑变更已核实 HEAD 的 serial_demo_test.rs:154 存在E0502借用冲突且本轮未触及Rust；不将前端通过视为Rust测试通过。C SDK/进程协议/编译路径未修改，未重复C/AOT专项。

## 2026-10-19 — 流程块拖动隔离与渲染优化

- 将节点拖动临时位置移入独立 FlowCanvas，按 requestAnimationFrame 合并高频移动，松手立即使用最新坐标；父 FlowEditor 和 FB 属性表单不再随拖动帧重新渲染。切换流程或卸载取消待执行帧，工程及恢复记录仍只在松手更新，单次拖动只形成一条撤销记录。
- 稳定父回调、画布选项、节点视图和 data 引用；运行高亮通过独立 Context 直接更新画布，相同高亮跳过发布，变化的高亮也不重绘属性表单，未改节点和连线继续复用。尺寸变化批量处理，连线使用节点索引查询端口，减少重复构建与线性查找。属性/命名端口编辑、边跟随、节点增删和主题继续响应。
- 浏览器运行指纹与原生一致，排除节点坐标、显示标签、流程和连接显示名称，保留有序节点、配置、FB 端口、连线及窗口 ID 等运行定义；拖动/重命名不再中断等待中的流程，实际配置修改仍取消旧执行。
- 新增 `src/designer/FlowCanvas.tsx`、`tests/e2e/flow-drag.spec.ts`；修改 `src/designer/FlowEditor.tsx`、`src/App.tsx`、`src/runtime/engine.ts`、`tests/runtime-v4.test.ts`、`docs/architecture.md` 和本文件。无删除或重命名，无依赖、工程格式、C SDK、进程协议或编译路径变更；原有 QuickGUI_Icons/ 保持未跟踪，不纳入提交。
- Chromium 开发环境同一 FB 工程、预先选中节点后执行 45 步真实鼠标移动：基线 6a982c6 的 FlowEditor/FunctionBlockEditor 各渲染 13 次，修后均为 0，仅 FlowCanvas 更新 13 次。使用同一 DevTools 提交统计，过滤复用 fiber 的陈旧标记；对照数据在忽略的 artifacts/flow-drag-render-comparison.json。该结果说明渲染工作隔离，不作为 FPS、原生实机或硬件性能验收。
- 新增浏览器回归覆盖拖动中修订/恢复数据不变、松手一次保存、单步撤销/重做、切换流程后位置保持、属性/命名端口编辑与连线跟随，以及后台定时/延时流程真实高亮持续切换时的拖动隔离；新增运行时回归覆盖延时流程跨移动/重命名继续执行、配置变更取消旧执行。
- 验证：TypeScript 与 262 项单测、生产构建通过；新增拖动 E2E 3/3 通过，包含运行高亮真实变化的回归。最终 `node artifacts/run-isolated-e2e.mjs` 在完整独立依赖/缓存的 1421 服务上沿用正式配置与标准超时，61/61 Chromium E2E 一次全部通过（1.4 分钟），原有 1420 开发服务保留。`npx tauri build --debug --bundles app` 通过，更新 `target/debug/bundle/macos/QuickGUI.app`（78.00 MiB）。Prettier 与 Git 差异检查通过，保留已有 Monaco 大包与桥接混合导入提示。
- 首轮复用 1420 时 55/60 通过，5 项动态导入夹具因有/无查询参数的双 React DOM 实例失败。隔离准备曾因依赖软链越过组件边界、部分依赖复制造成双 React 而失败或中止，另有一次 JSON 输入断言失败；改用完整独立依赖目录后，受影响 8 项定向复跑及最终 61 项全量均通过，未修改正式用例或放宽超时。对照、隔离脚本、依赖快照及报告属于忽略的生成物，日志保留在 `artifacts/isolated-e2e/`。
- `cargo test --workspace` 未能进入执行：基线已有 `crates/quickgui-engine/src/serial_demo_test.rs:154` 的 E0502 借用冲突，port 借用 delivery.event.kind 后又可变刷新 delivery.event；已核对 HEAD 同一代码，本次未修改该测试或 Rust 源文件。C 专项未重跑，本次未触及 SDK/协议/编译路径。

## 2026-10-19 — 借鉴 SerialWatch 的通信缓冲与界面批处理

- 审阅 `mini-berry/serialwatch` 修订 `24f8404e0dd1edd6acde4b9daa3f5d393418d9c8` 的接收缓冲与显示批处理。独立实现容量为一个最新快照的后台界面发布器，首次更新立即调度，后续以 16ms 间隔合并显示；WebView 序列化和广播移出 Engine 锁与异步 I/O 工作线程，慢界面不积压旧快照，最后一次更新在无新事件时仍会发出。发布前校验工程、修订、会话与工程代次。
- 数据事件、协议分帧、原始时间戳、历史与报警记录、最新状态查询和窗口生命周期继续即时处理，不将参考项目的 40ms 显示空闲等待用作通信或协议帧的等待。本轮未复制参考项目源码。
- 接收缓冲使用消费游标和行扫描游标，粘包逐帧消费时不搬移剩余数据，长行分批到达时只扫描新增字节；每次原生读取至多整理一次缓冲，复用分配并减少一次载荷复制。保留 raw/line/length16 的现有边界、空帧、UTF-8、线缆字节计数、监听代次和 256 批/1MiB 过载保护。
- 新增 `src-tauri/src/snapshot_publisher.rs`，修改 `src-tauri/src/lib.rs`、`src-tauri/src/windows.rs`、`src-tauri/src/source_export.rs`、`crates/quickgui-engine/src/serial.rs`、`crates/quickgui-engine/src/serial_tests.rs`、`docs/architecture.md` 和本文件。无源文件删除或重命名，无 C SDK、进程协议或编译路径改动。
- 新增 5 项回归，覆盖阻塞发布者下的生产者进度、有界内存与最终排空、过时代次过滤、所有读取切分位置的空帧与半帧、长行增量扫描，以及生产 I/O actor 中的 length16、UTF-8、线缆字节计数和预算回收；源码导出测试确认包含新增发布模块。
- 验证：`cargo test --workspace` 的 115 项常规测试及文档测试、`npm run check -- --maxWorkers=1` 的 TypeScript 检查与 260 项单测、`npm run build` 全部通过，13 项条件 Rust 测试默认忽略。`npm run test:e2e -- --config .toolchain/playwright-verification.config.ts` 的 58 项 Chromium E2E 在隔离的 1421 服务上一次全部通过，保持正式用例与标准超时，保留原有 1420 开发环境。Prettier、`cargo fmt --all -- --check` 与 Git 差异检查通过，保留既有桥接混合导入和 Monaco 大包提示。
- 本轮未打开实体串口，缓冲算法和内存传输测试不作为实体 USB 转串口性能验收；原记录的 41ms 改善幅度仍需原设备复测。参考源码、构建和测试产物均在忽略的生成物目录，不纳入源码提交。

## 2026-10-19 — USB 转串口小报文调度

- Windows 在 IOCP 注册及首个异步读取前配置首字节返回模式，缓冲区已有数据立即读取，空闲时等待首字节，避免字节间隔超时造成的小报文等待；保留写超时、独占、设备身份校验、关闭取消与原始收发时间戳。
- 引擎加载有效工程时缓存流程和拓扑顺序，重复收发激活复用不可变执行计划；热更新仍先完整校验，逻辑变更继续使旧执行失效。连续计算节点高亮通知按 16ms 采样，从通知完成时计算间隔，避免慢订阅者使采样失效；等待节点、变量写入、日志、错误、最终快照与通信事件保持即时通知。
- 修改 `crates/quickgui-engine/Cargo.toml`、`Cargo.lock`、`crates/quickgui-engine/src/serial.rs`、`crates/quickgui-engine/src/serial_tests.rs`、`crates/quickgui-engine/src/serial_demo_test.rs`、`crates/quickgui-engine/src/lib.rs`、`crates/quickgui-engine/src/flow_v4.rs`、`crates/quickgui-engine/src/flow_v4_tests.rs`、`crates/quickgui-engine/src/function_blocks.rs`、`docs/architecture.md` 和本文件；无源文件新增、删除或重命名，无 C SDK、进程协议或编译路径改动。
- 新增跨平台生产 I/O actor 的内存回环与队列过载回归，覆盖小缓冲拆包、连续收发、原始时间戳、空闲读取取消和预算回收；新增执行计划复用/失效、无效修订保留，以及慢订阅者下高亮采样、等待节点可见、写入/事件/日志/错误/最终清理即时可见回归。本轮未打开实体串口，内存回环不作为实体 USB 转串口性能验收；原记录的 41ms 改善幅度需原设备复测。
- 验证：`cargo test --workspace` 的 110 项常规测试及文档测试、`npm run check -- --maxWorkers=1` 的 TypeScript 检查与 260 项单测、`npm run build` 全部通过；13 项条件测试默认忽略。`npm run test:e2e -- --config .toolchain/playwright-verification.config.ts` 在隔离的 1421 服务上沿用正式用例与标准超时，58 项 Chromium E2E 全部通过，保留原有 1420 开发服务。Prettier、`cargo fmt --all -- --check` 与 Git 差异检查通过，保留既有 Monaco 大包与桥接混合导入提示。

## 2026-10-19 — 组件与流程块拖动性能

- 画布拖动按动画帧合并更新，仅对选中根控件设置临时 transform；调整大小仅更新当前控件的几何样式。松手后统一写入工程并严格校验，避免每次移动完整克隆、升级、校验模型和重渲染设计器。保留网格吸附、缩放坐标、多选移动、八向缩放、单次撤销与自动保存；释放时使用最新坐标，取消、失焦及卸载清理待执行帧与临时样式，并隔离其他触点。
- 流程块移动使用局部位置草稿，松手才提交模型与撤销记录；缓存节点和连线映射，移动时复用未改变的节点与卡片内容，减少整合流程图中的重复渲染。
- 修改 `src/designer/CanvasEditor.tsx`、`src/designer/FlowEditor.tsx`、`tests/e2e/canvas-interactions.spec.ts`、`docs/architecture.md` 和本文件；无源文件新增、删除或重命名，无 C SDK、进程协议或编译路径改动。浏览器性能测量脚本和结果位于忽略的 `.toolchain` 与 `artifacts`，不纳入源码提交。
- 本机隔离开发服务上的 Chromium 对 64 控件串口示例执行 90 步相同拖动，各测三次：工程修订增加量从 48 降至 1，布局计算从 97–98 次降至 2 次，帧间隔 P95 从约 200–333ms 降至 16.8ms。统计包含松手提交，优化后单次最大帧间隔仍为 233–267ms；此为浏览器开发环境测量，不作为原生实机性能验收。
- 验证：`npm run check -- --maxWorkers=1` 的 TypeScript 检查与 260 项单测、`npm run build`、`cargo test --workspace` 的 105 项常规测试及文档测试通过，13 项条件测试默认忽略。隔离 1421 服务上的 13 项拖动/设计器专项及最终完整 58 项 Chromium E2E 全部通过，保持正式超时设置和用户原有 1420 开发环境。新增回归覆盖 64 控件拖动中模型不变与最终持久化、松手最新坐标、待执行帧取消、多触点隔离、失焦和撤销取消，以及流程块单次提交与撤销/重做。Prettier 与 Git 差异检查通过；保留既有构建体积、混合导入与 Rust 未使用可变绑定提示。

## 2026-10-19 — 多流程整合与精确事件入口

- 串口助手由 16 条流程整合为一张图，共享发送参数、通信异步输出、端口筛选与错误处理，保留手动打开后开始监听的执行顺序；USB 助手由 5 条流程整合为一张图，使用一个发现 FB 和一个通信 FB。按钮分别绑定自己的入口，保留工程及可复用节点 ID，默认连接与发送策略不变。流程画布支持缩小至 10% 查看整图。
- 控件事件支持 `{flowId, entryNodeId}` 精确绑定；UI 可选择手动入口，浏览器、桌面桥接和独立运行共用相同入口语义，原始载荷不变。日志栏增加运行入口选择，未指定入口时拒绝多入口手动运行，避免同时启动全部操作。严格拒绝多入口歧义、无效与自动入口绑定；增加入口保留原关联，删除入口清理关联，跨工程复制同步重映射节点 ID。
- 新增 `src/core/flowBindings.ts`、`src/designer/FlowBindingSelect.tsx`、`src/examples/communicationFlow.ts`；修改 `src/core/types.ts`、`src/core/validation.ts`、`src/core/clipboard.ts`、`src/App.tsx`、`src/styles.css`、`src/designer/Inspector.tsx`、`src/designer/FlowEditor.tsx`、`src/runtime/RuntimeWindows.tsx`、`src/runtime/engine.ts`、`src/runtime/controller.ts`、`src/native/bridge.ts`、`src-tauri/src/lib.rs`、`crates/quickgui-engine/src/windows.rs`、`crates/quickgui-engine/src/flow_v4.rs`、`crates/quickgui-engine/src/flow_v4_tests.rs`、`scripts/export-project.mjs`。
- 修改 `src/examples/serialAssistant.ts`、`src/examples/usbAssistant.ts`、`examples/serial-assistant/quickgui.json`、`examples/usb-assistant/quickgui.json`、各示例 README、主 `README.md`、`docs/function-blocks.md`、`docs/architecture.md`；新增 `tests/flow-bindings.test.ts`、`tests/e2e/flow-bindings.spec.ts`，修改 `tests/serial-demo.test.ts`、`tests/communication-blocks.test.ts`、`tests/native-serial-bridge.test.ts`、`tests/e2e/serial-assistant.spec.ts`、`tests/e2e/usb-assistant.spec.ts`、`crates/quickgui-engine/src/serial_demo_test.rs`。更新本文件；无源文件删除或重命名，无 C SDK、工作进程协议或编译路径改动。
- 验证：`npm run check -- --maxWorkers=1` 的 TypeScript 检查与 260 项单测、`npm run build`、`cargo test --workspace` 的 105 项常规测试及文档测试通过，13 项条件测试默认忽略。原生编译并发期间既有组件重建单测曾超时，编译结束后串行完整重跑通过，未放宽超时。
- `npm run test:e2e -- --config .toolchain/playwright-verification.config.ts` 在隔离的 1421 服务上使用正式用例与标准超时，最终 55 项 Chromium E2E 全部通过；已目视检查两个整合流程图，保留用户原有 1420 开发环境。Prettier、`cargo fmt --all -- --check` 与 Git 差异检查通过；保留既有 Monaco 大包、桥接混合导入与 Rust 未使用可变绑定提示。
- 实际 Rust 引擎审计覆盖泵站计算、串口共享 FB 的 RX/TX/TIME、错误与清空入口、USB 系统枚举和精确设备选择，以及多手动入口的歧义拒绝；三个示例实际源码导出后与源工程逐字段一致，分别保留泵站 2 条流程 / 12 条数据线、串口 1 条流程 / 11 条数据线、USB 1 条流程 / 1 条数据线。本轮未进行实体 USB 或串口收发验收。审计程序、导出目录、日志与截图均保留在忽略的生成物目录，不纳入源码提交。

## 2026-10-19 — USB 原生通信与双 FB 接口

- USB 直接依赖 `dev-zuihong/usb_comm_rs` 当前修订 `830f6f4393014f6f6c98898956fb818b312cfb22`；设备发现与通信各提供一个 FB，串口面板同步收敛为两个 FB。命令执行线保留目标端口，原生异步收发、状态与错误从对应 FB 输出继续运行。
- USB 发现保留原始 HID 路径、接口与连接代次，支持精确设备选择、筛选和热插拔；HID 报告、Feature、描述符及 Windows USB Print 复用库会话。浏览器返回明确原生能力诊断；关闭、修订与取消负责资源回收和陈旧事件隔离。
- 修改模型与编辑器：`src/core/types.ts`、`src/core/validation.ts`、`src/core/flowV4.ts`、`src/core/functionBlocks.ts`、`src/designer/FlowEditor.tsx`；修改浏览器运行器：`src/runtime/engine.ts`、`src/runtime/flowV4Runtime.ts`、`src/runtime/functionBlockRuntime.ts`。
- 修改原生宿主：`crates/quickgui-engine/Cargo.toml`、`Cargo.lock`、`crates/quickgui-engine/src/lib.rs`、`crates/quickgui-engine/src/flow_v4.rs`、`crates/quickgui-engine/src/function_blocks.rs`、`crates/quickgui-engine/src/serial.rs`、`src-tauri/src/scheduler.rs`；新增 `crates/quickgui-engine/src/usb.rs`。无源文件删除或重命名。
- 串口 Demo 的全部串口节点收敛为两类 FB，原生设备变化、RX、TX、状态、错误均从 FB 输出，保留 64 个普通控件、16 条流程与稳定工程 ID；扩展后的端口按拓扑分列并预留高度，避免节点重叠。新增 USB 助手并注册欢迎页，提供 5 条流程、精确设备选择、共享会话、手动命令与异步输出分流，默认不打开或发送。跨工程粘贴将 USB 会话重新分配 ID，并携带关联的异步观察流程。同步示例说明与主 README 的双 FB 操作步骤、USB 原生能力及 Rust 1.88+ 要求。
- 修改 `src/core/examples.ts`、`src/core/clipboard.ts`、`src/examples/serialAssistant.ts`、`examples/serial-assistant/quickgui.json`、`examples/serial-assistant/README.md`、`README.md`、`docs/function-blocks.md`、`tests/serial-demo.test.ts`、`tests/e2e/serial-assistant.spec.ts`、`tests/e2e/function-blocks.spec.ts`、`crates/quickgui-engine/src/serial_demo_test.rs`；新增 `src/examples/usbAssistant.ts`、`examples/usb-assistant/quickgui.json`、`examples/usb-assistant/README.md`、`tests/communication-blocks.test.ts`、`tests/e2e/usb-assistant.spec.ts`、`crates/quickgui-engine/src/usb_tests.rs`。更新本文件记录；无 SDK、进程协议或编译路径改动。
- 验证：`npm run check -- --maxWorkers=2` 的 TypeScript 与 254 项单测、`npm run build`、`cargo test --workspace` 的 103 项常规测试及文档测试通过，13 项条件测试默认忽略。检查期间保留用户原有 1420 开发环境；后台原生编译曾使默认并发的既有组件构建单测超时，因此仅降低检查并发，未放宽超时。
- `npm run test:e2e -- --config .toolchain/playwright-verification.config.ts` 使用隔离的 1421 服务，沿用正式用例和标准超时，54 项 Chromium E2E 一次全部通过；USB 预览截图已目视检查。Prettier、`cargo fmt --all -- --check` 与 Git 差异检查通过，保留既有 Monaco 大包、桥接混合导入和 Rust 未使用可变绑定提示。
- 实际 Rust 引擎执行三个示例，覆盖泵站调速与计数、串口 FB 收发数据及错误/清空语义、USB 系统发现与精确设备选择。三个示例实际源码导出后与源工程逐字段一致，保留全部流程和数据线，并包含 USB 服务及 Git 依赖。真实系统枚举与流程事件测试不等同于实体 USB 或串口收发验收；本轮未进行实体通信。审计程序、导出目录、日志和截图均保留在忽略的生成物目录，不纳入源码提交。

## 2026-10-19 — 更新 Demo 展示 FB 多路端口

- 泵站示例直接以 v5 / v2 定义控件和趋势绑定；循环计数显式区分执行线与数据线。增加可在浏览器和桌面运行的调速示例、额定转速输入及转速/余量结果：默认 65% × 3000 rpm 得到 1950 rpm，余量 35%。新流程展示双输入数学、双输入双输出结果块、按需读取和输出分接。
- 串口示例的全部节点显式定义 FB 接口，手动/定时发送分别接入数据、编码与行尾；收发事件将报文和时间分别输出至历史与最近收发显示。固定写入值通过端口默认值保留，错误/断开继续停止定时发送，清空操作不复制上游报文。保留 64 个普通控件、16 条流程与原有安全默认值。
- 修改 `src/core/project.ts`、`src/examples/serialAssistant.ts`、`examples/pump-station/quickgui.json`、`examples/serial-assistant/quickgui.json`、`examples/serial-assistant/README.md`、`README.md`、`docs/function-blocks.md`、`tests/serial-demo.test.ts`、`tests/e2e/designer.spec.ts`、`tests/e2e/function-blocks.spec.ts`、`tests/e2e/multi-window.spec.ts`、`CHANGELOG.md`；新增 `src/examples/pumpSpeed.ts`、`examples/pump-station/README.md`、`tests/pump-demo.test.ts`。保留两个源文件示例的工程 ID，无源文件删除或重命名，无 C SDK、进程协议或编译路径变更。
- 验证：`npm run check` 的 TypeScript 与 247 项单测、`npm run build`、`cargo test --workspace` 的 98 项常规测试及文档测试通过，13 项条件测试默认忽略。52 项 Chromium E2E 中首轮 49 项通过；修正千位分隔符与旧 Demo 控件/连线数量断言后，剩余 3 项全部重跑通过，未放宽超时。E2E 使用隔离的 1421 服务，用户原有 1420 开发进程保持运行。
- 实际 Rust 引擎读取两个更新后的 Demo，验证 5 组调速输入、次数累加、RX/TX 报文与时间分流、错误停止定时发送及清空记录；这属于流程语义验证，未进行实体串口通信。调速日志直接显示输入数值，浏览器与 Rust 均验证通过。两个 Demo 实际导出为独立源码，逐字段核对导出工程与源文件相同，泵站保留 2 条流程/12 条数据线，串口保留 16 条流程/14 条数据线。
- 已目视检查泵站预览截图；Prettier 与 Git 差异检查通过。保留既有 Monaco 大包、桥接混合导入和 Rust 未使用可变绑定提示；临时审计程序、导出源码、日志和截图均位于忽略的生成物目录，不纳入源代码提交。

## 2026-10-19 — 默认使用最新工程模型

- 按当前需求统一工作副本为 schema v5、控件属性为 definitionVersion 2。新建、打开、恢复、复制、保存和导出直接使用当前模型；已知旧文件仅在入口一次性转换，移除版本升级弹窗与旧版运行分支。撤销/重做不再回退工程版本；新建流程和示例节点默认显示 FB 端口。
- 浏览器与 Rust 统一使用 FB 图执行器、严格数值运算和 JSON 结构比较、实际写入值转发及持续事件域。逻辑编辑取消旧工作，纯外观更新保留有效执行；C 仍在独立进程执行，SDK ABI 与进程协议未变。
- 命令行源码导出和组件重建复用工程校验器并写入规范化结果；原生源码导出要求设计器当前 v5 文档。未知版本、无效引用、结构和草稿继续严格拒绝。
- 修改核心：`src/core/types.ts`、`src/core/migration.ts`、`src/core/project.ts`、`src/core/validation.ts`、`src/core/store.ts`、`src/core/archive.ts`、`src/core/clipboard.ts`、`src/core/windows.ts`。
- 修改界面：`src/App.tsx`、`src/designer/FlowEditor.tsx`、`src/designer/CanvasEditor.tsx`、`src/designer/Inspector.tsx`、`src/panels/ConnectionsPanel.tsx`、`src/panels/PasteReviewDialog.tsx`；删除未再使用的 `src/designer/LegacyInspector.tsx`。
- 修改运行器：`src/runtime/engine.ts`、`src/runtime/controller.ts`、`src/runtime/WidgetRenderer.tsx`、`src/runtime/RuntimeWindows.tsx`、`src/runtime/windowState.ts`、`src/runtime/flowV4Runtime.ts`、`crates/quickgui-engine/src/lib.rs`、`crates/quickgui-engine/src/flow_v4.rs`、`crates/quickgui-engine/src/function_blocks.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/scheduler.rs`。
- 修改导出和示例：`scripts/export-project.mjs`、`scripts/build-component.mjs`、`src-tauri/src/source_export.rs`、`src/examples/serialAssistant.ts`、`examples/serial-assistant/quickgui.json`。
- 修改回归：`tests/project-v3.test.ts`、`tests/project-compatibility.test.ts`、`tests/project-windows.test.ts`、`tests/project-windows-store.test.ts`、`tests/core.test.ts`、`tests/runtime-v3.test.ts`、`tests/multi-window-runtime.test.ts`、`tests/flow-v4.test.ts`、`tests/function-blocks.test.ts`、`tests/clipboard.test.ts`、`tests/widget-definitions.test.ts`、`tests/widget-migration.test.ts`、`tests/serial-demo.test.ts`、`tests/component-rebuild.test.ts`、`tests/e2e/function-blocks.spec.ts`、`tests/e2e/v3-integration.spec.ts`、`tests/e2e/serial-assistant.spec.ts`、`tests/e2e/widget-properties.spec.ts`、`tests/e2e/components.spec.ts`、`tests/e2e/designer.spec.ts`、`tests/e2e/multi-window.spec.ts`、`crates/quickgui-engine/src/flow_v4_tests.rs`、`crates/quickgui-engine/src/function_blocks_tests.rs`、`crates/quickgui-engine/src/serial_demo_test.rs`、`crates/quickgui-engine/src/windows.rs`。
- 修改说明：`README.md`、`docs/architecture.md`、`docs/project-compatibility.md`、`docs/function-blocks.md`、`templates/runtime/README.md`、`CHANGELOG.md`。本轮无源文件新增或重命名。
- 最终验证：`npm run check` 的 TypeScript 检查与 244 项单测、`npm run build`、`cargo test --workspace` 的 98 项常规测试与文档测试全部通过；13 项条件测试默认忽略。保留既有 Monaco 大包、桥接混合导入与 Rust 未使用可变绑定提示。
- 完整 51 项 Chromium E2E 在隔离的 1421 服务一次通过，沿用正式配置、全部用例和标准超时；用户原有 1420 开发服务保持运行。实际命令行导出 v4 串口工程，确认输出为 v5、全部控件 definitionVersion 2，16 条流程完整保留。
- 真实 C 验证：`npm run test:c` 的 13 项、FB 命名输入/多输出/实例状态隔离 JIT/AOT 等价 1 项、变量别名/原子写入 JIT/AOT 等价 1 项全部通过。Prettier、`cargo fmt --all -- --check` 与 Git 差异检查通过；验证日志、导出工程和临时配置均位于忽略的生成物目录。

## 2026-10-19 — PLC 风格流程功能块与多路数据端口

- 增加显式 v5 工作副本升级和版本化 FB 接口。执行端口与命名数据端口分开，输入支持类型、参数/字段绑定和默认值，输出支持类型化 JSON 路径；每侧最多 16 路，输出可分接，输入禁止重复数据源或类型不兼容连接。
- 流程卡片按端口逐行布局，显示 EN/ENO、条件/错误分支和各路参数/结果；C 脚本可编辑多路接口。稳定端口 ID 保证改名保留连线，移除端口清理对应数据线，无效草稿不覆盖接口。切换串口操作同步参数接口，保留匹配端口身份、默认值、输出与执行连线，仅清理已移除参数的数据线。
- 浏览器和 Rust 运行器共用相同数据契约：按本次执行采样，未接 EN 的依赖按需求值、多输出共享一次调用；已接 EN 但未触发的源不能提供旧值。C FB 的状态按流程/节点/脚本实例隔离，保留原脚本语义，不修改 SDK ABI 或进程协议。
- 修改 `src/core/types.ts`、`src/core/validation.ts`、`src/core/migration.ts`、`src/core/flowV4.ts`、`src/core/clipboard.ts`、`src/runtime/engine.ts`、`src/designer/FlowEditor.tsx`、`src/designer/designer.css`、`src/App.tsx`；新增 `src/core/functionBlocks.ts`、`src/runtime/functionBlockRuntime.ts`、`src/designer/FunctionBlockEditor.tsx`。
- 修改 `crates/quickgui-engine/src/types.rs`、`crates/quickgui-engine/src/lib.rs`、`crates/quickgui-engine/src/flow_v4.rs`、`crates/quickgui-engine/src/windows.rs`、`src-tauri/src/source_export.rs`、`scripts/export-project.mjs`；新增 `crates/quickgui-engine/src/function_blocks.rs`、`crates/quickgui-engine/src/function_blocks_tests.rs`、`crates/quickgui-engine/tests/fixtures/function-blocks.json`、`crates/quickgui-c-runner/tests/function_block.rs`、`sdk/tests/function-block.c`。
- 修改 `tests/flow-v4.test.ts`、`tests/project-windows.test.ts`、`tests/project-compatibility.test.ts`、`crates/quickgui-engine/src/flow_v4_tests.rs`；新增 `tests/function-blocks.test.ts`、`tests/e2e/function-blocks.spec.ts`，验证多输入、多输出、分接、严格校验、旧版本隔离、可撤销升级、草稿、复制、错误和执行隔离。修改 `README.md`、`docs/architecture.md`、`docs/project-compatibility.md`、`templates/runtime/README.md`、`CHANGELOG.md`，新增 `docs/function-blocks.md`。无源文件删除或重命名。
- 验证：`npm run check` 的 TypeScript 与 245 项单元测试、`npm run build`、`cargo test --workspace` 的 98 项常规测试与文档测试通过，13 项条件测试默认忽略。51 项 Chromium E2E 中 48 项首轮通过；3 项导航超时在原生编译结束后通过 `npm run test:e2e -- --last-failed` 全部重跑通过。首次并发检查中的既有组件构建测试超时、原生文档测试缓存暂时缺失均在重跑后消失，未放宽测试超时。
- 真实 C 专项：`npm run test:c` 的 13 项、同源 aliases JIT/AOT 等价 1 项、FB 命名输入/多输出/共享调用与实例状态隔离 JIT/AOT 等价 1 项全部通过。FB AOT 使用本机 MSVC 工具链编译，SDK ABI 和进程协议未改动。
- 实际命令行导出 v5 源码并核对数据线和双端运行器；Rust 原生导出回归同时验证接口完整保留。FB 界面截图已目视检查；Prettier、Cargo fmt 与 Git 差异检查通过。源码导出审计、截图和 AOT worker 均位于忽略的生成物目录，不纳入源码提交。

## 2026-10-19 — Windows 发布包不内置 WebView2

- 将 Windows WebView2 安装策略从 `offlineInstaller` 改为 `downloadBootstrapper`，发布包不再携带运行时离线安装器。设计器和两条独立源码导出路径共用该配置；目标电脑优先使用已安装的 WebView2，缺失时由安装器联网下载并静默安装。
- 在发布及独立源码说明中明确离线安装或直接运行 EXE 需预先安装 WebView2。
- 修改 `src-tauri/tauri.conf.json`、`README.md`、`templates/runtime/README.md`、`CHANGELOG.md`；无源文件新增、删除或重命名，无 C SDK、进程协议或编译路径变更。
- 实际通过命令行导出串口助手独立源码，核对设计器及导出配置均为 `downloadBootstrapper`；Rust 原生源码导出回归通过。`npm run check`（233 项）、`npm run build`、`npm run test:e2e`（48 项）、`cargo test --workspace`（89 项常规测试）通过，12 项条件测试默认忽略；格式及 Git 差异检查通过。本轮未生成或安装完整发布包。

## 2026-10-19 — Windows 独立运行应用导出过程输出

- 构建开始自动展开设计器控制台，持续显示源码导出、工具链、依赖安装、编译打包与错误输出；结束后保留最近 1000 条构建记录，不受原生运行快照覆盖，支持滚动和清空。
- Windows 构建及取消进程使用无控制台窗口标志，标准输出/错误通过管道返回设计器；支持 CR、LF、CRLF、无换行尾部及含非 UTF-8 字节的工具输出，限制单条输出大小，失败退出时先读取最终诊断再返回错误。
- 修改 `src/App.tsx`、`src/styles.css`、`src-tauri/src/build_runtime.rs`、`CHANGELOG.md`；新增 `tests/e2e/build-output.spec.ts`。无源文件删除或重命名，无 C SDK、工作进程协议或编译命令变更。
- Rust 新增 5 项输出/进程回归，覆盖实时 CR 输出、CRLF、非法 UTF-8、跨读取 UTF-8、长行限制、失败尾部诊断、取消进程树及含空格路径的 Windows 批处理。2 项浏览器用例以受控原生事件验证自动展开、快照刷新后保留、结束/失败/取消、去重、清空与监听释放，不作为真实打包验收。
- `cargo test --workspace` 的 89 项常规测试通过；固定版本 TinyCC 在本机准备后，`npm run test:c` 的 13 项测试及同源 JIT/AOT 别名/原子写入等价测试 1 项通过。实际执行 `node scripts/build-aot.mjs sdk/tests/aliases.c .toolchain/aot-aliases` 生成 Windows AOT worker；生成物不提交。
- 隔离的 Windows 原生调试宿主实际导出源码、运行 Node/Cargo 工具链检查并在依赖阶段取消，确认真实标准输出通过 `build-progress` 返回，取消正常收敛。未完成本轮安装包产出、签名或性能验收。
- 常规检查：最终默认 `npm run check` 的 TypeScript 检查及 233 项单测、`npm run build` 通过；48 项 Chromium E2E 中首轮 47 项通过，1 项画布用例在并行编译时超时，构建结束后定向重跑通过。组件重建测试期间的 5 秒超时亦在最终默认检查中消除，无相关源码改动。Prettier、Cargo fmt 与 Git 差异检查通过；保留已有 Monaco 大包、桥接混合导入及 Rust 未使用可变绑定提示。

## 2026-10-19 — 标题栏跟随设计器主题

- 修复主题切换只更新网页样式、原生标题栏仍使用系统主题的问题：通过 Tauri 原生窗口接口同步亮/暗主题，保留系统标题栏与窗口按钮。
- 设计器统一管理主题状态，启动时恢复保存的选择；关闭工程进入欢迎页、刷新及重新打开工程时保持一致。浏览器仅应用网页主题，原生同步失败输出明确错误。
- 修改 `src/App.tsx`、`src/panels/WelcomeScreen.tsx`、`src/native/bridge.ts`；新增 `src-tauri/capabilities/designer-theme.json`，仅向设计器主窗口授予设置主题权限。
- 修改 `tests/e2e/project-close.spec.ts`，覆盖亮/暗切换、刷新、关闭工程、欢迎页及恢复工程的主题保持；修改 `CHANGELOG.md` 记录本次变更。无源文件删除或重命名，无 C SDK、进程协议或编译路径变更。
- Windows 原生调试宿主使用独立应用标识与 WebView 数据目录，实际读取 Tauri 有效主题及 DWM 深色标题栏属性，8 项初始主题、亮/暗切换、刷新、关闭工程、欢迎页与恢复工程检查一致；测试进程已清理。浏览器回归不作为原生标题栏验收。

## 2026-10-19 — 串口助手 Demo 与可复用 v4 流程组件

### 目的与行为

- 新增普通可编辑串口助手工程：64 个通用控件、16 条可视化流程，经数据和事件绑定完成枚举、插拔检测、VID/PID 过滤、手动打开/关闭、监听、UTF-8/HEX 收发、换行、时间戳、计数、有界记录及定时发送；无特定工程/控件 ID 的运行时分支，无自定义 React/C、模拟器或 Web Serial。
- 新增 schema v4 的 serial/map/append 节点、ValueRef、串口事件和受控定时器，支持 success/error 分支；UI/CODE、严格验证、迁移、删除保护、依赖闭包、复制重映射与导出共用类型/引用语义。v1–v3 原格式往返，新增空工程仍为 v3；使用 v4 能力明确确认升级，支持撤销，拒绝未知 v5。
- 原生串口使用独立读写任务、进程级端口占用及有界队列。RX 待处理上限 256 批/1 MiB，溢出立即关闭、取消发送并锁定故障，手动重开才能恢复；显示历史独立限制 500 条/512 KiB，并报告淘汰数。RX framing 支持 raw/line/length16；TX 仅发送编码后的原文和选定换行，不加长度前缀。旧连接诊断语义保留。
- 默认 115200/8N1/无流控、原始接收、定时发送 1000 ms（最小 100 ms）、自动重连关闭。重连必须同时匹配已知 VID、PID、规范端口名、USB busId/portChain；不替代为序列号或唯一 VID/PID。连接/重连时锁定端口及参数，错误/断开停止定时发送；故障恢复不自动重新启用定时发送。
- v4 IO/C/延迟等待释放引擎锁，UI 流程可并行；同一 C 脚本状态串行提交。单调执行代际阻止编辑后撤销时旧结果回写。外观热更新保留原生端口与兼容状态，子窗口共享所属运行时，关闭工程清理句柄及任务。
- 当前计数由合并的状态事件发布；data 及通用 map/write/append 保留不可变快照，旧排队数据不会恢复 Demo 已重置的计数。计数状态和数据公平调度，故障独立优先投递，避免状态通知挤占数据；发送错误保留本次错误。
- 桌面连接页可扫描真实端口并查看 USB 元数据、配置通信参数。浏览器明确返回 NATIVE_SERIAL_REQUIRED，不生成虚假设备/数据。独立源码包含示例模块依赖并保留 v4 原生运行语义；更新使用、兼容性、架构与验证文档。
- Rust 引擎显式启用已锁定 serialport 4.10.1 的 usbportinfo-location 功能；无新增 npm 依赖，无 C SDK/ABI 修改。生成物、图标和用户原有 QuickGUI_Icons/ 不纳入本次改动。无源文件删除或重命名。

### 源文件操作

- 修改 `Cargo.lock`
- 修改 `README.md`
- 修改 `crates/quickgui-c-runner/tests/aliases.rs`
- 修改 `crates/quickgui-engine/Cargo.toml`
- 修改 `crates/quickgui-engine/src/connections.rs`
- 新增 `crates/quickgui-engine/src/flow_v4.rs`
- 新增 `crates/quickgui-engine/src/flow_v4_tests.rs`
- 修改 `crates/quickgui-engine/src/lib.rs`
- 新增 `crates/quickgui-engine/src/serial.rs`
- 新增 `crates/quickgui-engine/src/serial_demo_test.rs`
- 新增 `crates/quickgui-engine/src/serial_tests.rs`
- 修改 `crates/quickgui-engine/src/types.rs`
- 修改 `crates/quickgui-engine/src/windows.rs`
- 修改 `docs/architecture.md`
- 修改 `docs/project-compatibility.md`
- 新增 `docs/serial-v4-contract.md`
- 修改 `docs/verification.md`
- 新增 `examples/serial-assistant/README.md`
- 新增 `examples/serial-assistant/quickgui.json`
- 修改 `scripts/export-project.mjs`
- 修改 `src-tauri/build.rs`
- 修改 `src-tauri/src/close_project_tests.rs`
- 修改 `src-tauri/src/lib.rs`
- 修改 `src-tauri/src/scheduler.rs`
- 修改 `src-tauri/src/source_export.rs`
- 修改 `src/App.tsx`
- 修改 `src/core/clipboard.ts`
- 新增 `src/core/examples.ts`
- 新增 `src/core/flowV4.ts`
- 修改 `src/core/migration.ts`
- 修改 `src/core/references.ts`
- 修改 `src/core/store.ts`
- 修改 `src/core/types.ts`
- 修改 `src/core/validation.ts`
- 修改 `src/designer/CanvasEditor.tsx`
- 修改 `src/designer/FlowEditor.tsx`
- 新增 `src/designer/FlowValueRefEditor.tsx`
- 新增 `src/examples/serialAssistant.ts`
- 修改 `src/native/bridge.ts`
- 修改 `src/panels/ConnectionsPanel.tsx`
- 修改 `src/panels/WelcomeScreen.tsx`
- 修改 `src/runtime/controller.ts`
- 修改 `src/runtime/engine.ts`
- 新增 `src/runtime/flowV4Runtime.ts`
- 修改 `src/runtime/windowState.ts`
- 新增 `tests/e2e/serial-assistant.spec.ts`
- 新增 `tests/flow-v4.test.ts`
- 新增 `tests/native-serial-bridge.test.ts`
- 修改 `tests/project-compatibility.test.ts`
- 修改 `tests/project-windows.test.ts`
- 新增 `tests/runtime-v4.test.ts`
- 新增 `tests/serial-demo.test.ts`

### 验证与边界

- TypeScript 检查及 233 项单测、生产构建、45 项 Chromium E2E 全过；最后 Demo 计数分支修复后重跑 233 项及 4 项串口 E2E 通过。
- `cargo test --workspace` 最终 95 项常规测试通过（引擎 67、宿主 24、runner 4），13 项条件测试默认忽略后分别执行：真实 C 14/14、同源 aliases JIT/AOT 1/1、实际 C 关闭取消 1/1、最终 Demo + 真实 PTY 1/1 均通过。串口定向 17/17 包含重连锁定、队列公平/故障优先、发送错误保留、计数重置与快照语义。PTY 测试使用 cfg(test) 注册的真实预打开 slave 绕过 macOS PTY 不支持的 modem ioctl，仍走生产打开/租约/会话/IO；无生产模拟器，未打开物理串口。
- 最终 Demo 独立源码实际导出到忽略的 `artifacts/serial-standalone-verified`，`npm ci --ignore-scripts`、生产构建、`cargo check --workspace` 通过；独立生产页面实际验证 64 控件、默认参数、发送禁用、真实能力诊断、无虚假端口/记录/计数，无页面错误或设计器开发请求。
- `npx tauri build --debug --bundles app` 通过，更新 `target/debug/bundle/macos/QuickGUI.app`（71.48 MiB）；包内 ICNS/worker 与源图标/暂存 worker 一致，从 `/tmp` 执行包内 C self-test 成功（output=21/state.runs=1、加载包内 libtcc）。Prettier、Cargo fmt 和 Git 差异检查通过。保留已有 Monaco 大包及桥接混合导入提示。
- 验证中发现的遗漏导出依赖、旧数据覆盖重置、隐式刷新改变快照、状态挤占数据及旧错误覆盖发送错误已修正并回归；最终产物保留通用流程语义。详细验证及边界见 `docs/verification.md`。本记录与对应源文件一并提交，生成物不提交。
- 不以 PTY/本机回环代替物理串口、USB 驱动热插拔、真实波特率/流控或硬件重连验收；Windows/Intel Mac 实机、签名公证、耐久与吞吐/延迟基准本轮未执行。

## 2026-10-18 — 统一下拉框高度并修复菜单失焦关闭

- 设计器单行下拉框统一为 32px，使用一致的内边距、行高及主题色箭头，消除浏览器原生外观造成的高度差异；排除工程控件、预览场景、多选和列表框，保留工程自设尺寸。
- 工程、导出和右键菜单在点击外部、焦点移出或收到窗口 blur 时关闭；菜单内移动焦点保持打开。工程与导出菜单互斥，Esc 关闭后恢复触发按钮焦点，并补充展开状态关联。
- 修复属性面板错误的输入背景令牌，亮色主题不再出现深色底与深色文字混用。
- 新增 `src/hooks/useDismissibleLayer.ts`：共享外部指针、焦点与窗口失焦关闭逻辑，卸载时清理监听。
- 修改 `src/App.tsx`、`src/designer/ContextMenu.tsx`：接入失焦关闭、菜单互斥、Esc 和焦点恢复。
- 修改 `src/styles.css`、`src/designer/propertyInspector.css`：下拉框统一尺寸与外观、属性输入主题背景。
- 新增 `tests/e2e/dropdowns.spec.ts`：5 项亮/暗高度、画布/预览尺寸隔离、外部点击、Tab/焦点移出、菜单内部操作、互斥、Esc、下载及窗口 blur 回归。
- 修改 `CHANGELOG.md` 记录本组变更；无源文件删除或重命名，无工程格式、依赖、配置迁移或 C SDK/协议/编译路径变更。原有 `QuickGUI_Icons/` 未改动或纳入提交。
- 验证：`npm run check` 的 TypeScript 与 195 项单测、`npm run build`、41 项 Chromium E2E、5 项 WebKit 专项及 `cargo test --workspace` 的 65 项常规测试均通过。首次回归发现画布控件被尺寸规则误命中，以及测试 DOM 类型/递归参数推断错误，已限定样式作用域、明确 DOM 类型并序列化初始参数后复跑通过。
- `npx tauri build --debug --bundles app` 通过，更新 `target/debug/bundle/macos/QuickGUI.app`（67.31 MiB）；保留已有 Monaco 大包及桥接混合导入提示。亮/暗主题截图及测量在忽略的 `artifacts/dropdown-audit/`，已目视检查。
- Prettier 与 Git 差异检查通过。本轮未重复默认忽略的真实 C/AOT 专项；窗口 blur 为浏览器事件回归，原生系统焦点自动点击、Windows/Intel Mac 实机和签名公证未验收。

## 2026-10-18 — 重绘折叠 Q LOGO 并校准桌面图标尺寸

- 按提供的品牌展示图重建较厚的折叠丝带 Q，保留青/蓝/紫/粉/金渐变和开放内孔，保存为 `public/quickgui.svg`，统一顶部品牌、欢迎页与浏览器 favicon。顶部缩至 28px、欢迎页缩至 64px，保持透明留白与适度投影。
- 将同一组矢量路径和渐变保存到 `src-tauri/icons/app.svg`，标志居中缩至 84%，增加白色圆角底板。对照本机计算器与系统设置图标的实际不透明边界，将底板从铺满画布改为 1024px 画布内的 816px，四边各留 104px 透明空间，主体比例均为 79.6875%。通过现有 Tauri 流程生成 PNG、ICO 和 ICNS，不嵌入品牌展示图片。
- 界面与桌面分别使用对应目录中的副本，运行、构建和独立源码不引用 `QuickGUI_Icons`；该用户素材目录保持原样且不纳入本次提交。工程自定义应用图标和快捷方式图标沿用原规则。
- 修改 `public/quickgui.svg`、`src-tauri/icons/app.svg`：参考图重绘后的透明界面 LOGO 和带安全边距的白底桌面矢量源。
- 修改 `src-tauri/icons/32x32.png`、`src-tauri/icons/64x64.png`、`src-tauri/icons/128x128.png`、`src-tauri/icons/128x128@2x.png`、`src-tauri/icons/icon.png`、`src-tauri/icons/icon.ico`、`src-tauri/icons/icon.icns`：重新生成并纳入版本控制的桌面图标资源。
- 修改 `src/styles.css`、`README.md`、`CHANGELOG.md`：透明 LOGO 布局、图标来源/构建说明和本次记录。无源文件新增、删除或重命名，无工程格式、依赖或迁移变更。
- 设计规格：厚折叠丝带 Q、青蓝紫粉金渐变、透明界面版本与白底桌面版本，不含文字或截图。曾调用内置 imagegen，但未返回可保存文件；最终按已读取的本地参考图重建 SVG，未使用 API/CLI 回退。
- 验证：`npm run icons` 生成最终图标成功；XML 核验路径/渐变一致且无位图或外部引用。实际解码 PNG、ICNS 后与本机系统图标比较不透明主体比例，确认白底已留出系统一致的边距；亮/暗主题顶部、欢迎页与小尺寸 favicon 均检查显示和裁切。
- `npm run check` 的类型检查及 195 项单测、`npm run build`、36 项浏览器 E2E、`cargo test --workspace` 的 65 项常规测试均通过。保留已有 Monaco 大包及桥接混合导入提示；本次未修改 C SDK、工作进程协议或 C 编译路径，未重复执行默认忽略的真实 C/AOT 专项。
- `npx tauri build --debug --bundles app` 通过，更新 `target/debug/bundle/macos/QuickGUI.app`（67.31 MiB）。包内 ICNS 与最终源图标逐字节一致，生产 favicon 与透明 SVG 一致；最终 PNG/ICNS 主体比例均为 79.6875%，与本机两个系统图标解码后的主体边界相同。浏览器实测顶部 28×28、欢迎页 64×64，亮/暗主题无异常；对比图及报告位于忽略的 `artifacts/brand-refit/`。
- Prettier 与 Git 差异检查通过。Windows/Intel Mac 实机、原生系统桌面图标缓存刷新、签名与公证本轮未验收；不以文件格式检查或本机构建代替系统实机验收。

## 2026-10-18 — v3 画布操作、详细属性与跨工程组件

### 目的与行为

- 完成画布直接滚轮锚点缩放（10%–800%）、空格/中键平移、按窗口/模块记忆视图、框选/Shift 多选、批量移动、八向缩放及 Shift 比例约束；右键菜单、快捷键、对齐分布、图层顺序与树状锁定/隐藏共用命令。每次手势或批量操作是一条撤销历史，编辑状态不改变运行可见性。
- 14 类控件统一属性元数据，支持搜索、分组、草稿提交/取消、重置与取消覆盖、状态样式、绑定模式/类型约束。UI/CODE 编辑同一控件；详细输入、选项、图片、容器、仪表、多曲线图表和动态表格语义由设计态/预览/独立运行共用。
- 新工程为 schema v3；旧 v1/v2 保持原格式，明确使用新能力才升级工作副本，旧控件仍保留 definitionVersion 1。单独升级控件时转换趋势曲线、旧表头、选择值与输入提交语义，保留未知扩展，无法表示的冲突拒绝并回滚。
- 跨工程复制依赖闭包并审阅，默认新建 ID、关闭导入流程与窗口自动启动，复用及 C/React 信任须明确选择；同打开会话复制保留引用与旧格式。源主题/语言/资源与目标主题可选择，C 别名和 React 原包身份保留源码不改写。移除连接凭据，系统剪贴板失败明确降级为本进程内存。
- JSON 初值/运行值与流程读写支持类型化路径，叶子写入不丢兄弟数据；运行值等待修订接受后编辑，编译失败不会把旧 C 执行冒充新脚本测试。名称/ID 与 value/JSON Pointer 目标按统一规则处理；引用检查覆盖历史曲线、C 别名及语言变量。
- 组件包 v2 携带属性描述、主题、翻译与图片；内嵌图片优先且同 ID 去重。组件构建复用校验定义；独立源码通过 --project/--module 按本地 ID 原子回填运行 bundle，保留原包身份及资源。原生/CLI 导出支持完整 v3。
- 更新操作、兼容性、架构、独立源码重建与验证文档；无新增本组依赖（剪贴板 Rust 依赖已在前一基础提交记录），无源文件删除或重命名。用户原有 QuickGUI_Icons/ 不属于本次改动。

### 源文件操作

- 修改 `README.md`
- 修改 `docs/architecture.md`
- 修改 `docs/project-compatibility.md`
- 修改 `docs/verification.md`
- 修改 `scripts/build-component.mjs`
- 修改 `scripts/export-project.mjs`
- 修改 `src-tauri/src/source_export.rs`
- 修改 `src/App.tsx`
- 新增 `src/core/clipboard.ts`
- 修改 `src/core/componentPackage.ts`
- 新增 `src/core/migration.ts`
- 修改 `src/core/project.ts`
- 新增 `src/core/propertySchema.ts`
- 新增 `src/core/references.ts`
- 修改 `src/core/store.ts`
- 修改 `src/core/validation.ts`
- 修改 `src/core/widgetDefinitions.ts`
- 修改 `src/core/windows.ts`
- 修改 `src/designer/CanvasEditor.tsx`
- 新增 `src/designer/ContextMenu.tsx`
- 修改 `src/designer/Fields.tsx`
- 修改 `src/designer/FlowEditor.tsx`
- 修改 `src/designer/Inspector.tsx`
- 新增 `src/designer/LayerTree.tsx`
- 新增 `src/designer/LegacyInspector.tsx`
- 新增 `src/designer/commands.ts`
- 修改 `src/designer/designer.css`
- 新增 `src/designer/propertyInspector.css`
- 新增 `src/panels/JsonValueField.tsx`
- 新增 `src/panels/PasteReviewDialog.tsx`
- 新增 `src/panels/pasteReview.css`
- 修改 `src/runtime/CustomComponent.tsx`
- 新增 `src/runtime/DataWidgets.tsx`
- 修改 `src/runtime/RuntimeWindows.tsx`
- 修改 `src/runtime/WidgetRenderer.tsx`
- 修改 `src/runtime/controller.ts`
- 修改 `src/runtime/engine.ts`
- 修改 `src/runtime/runtime.css`
- 修改 `src/styles.css`
- 修改 `templates/runtime/README.md`
- 新增 `tests/clipboard.test.ts`
- 修改 `tests/component-package.test.ts`
- 新增 `tests/component-rebuild.test.ts`
- 新增 `tests/e2e/canvas-interactions.spec.ts`
- 新增 `tests/e2e/v3-integration.spec.ts`
- 新增 `tests/e2e/widget-properties.spec.ts`
- 新增 `tests/editor-commands.test.ts`
- 新增 `tests/editor-transactions.test.ts`
- 修改 `tests/native-controller.test.ts`
- 修改 `tests/project-compatibility.test.ts`
- 新增 `tests/project-v3.test.ts`
- 修改 `tests/project-windows.test.ts`
- 修改 `tests/runtime-v3.test.ts`
- 新增 `tests/widget-definitions.test.ts`
- 新增 `tests/widget-migration.test.ts`
- 修改 `CHANGELOG.md` 记录本组变动，不递归记录日志自身。

### 验证与限制

- npm run check：TypeScript 与 195 项单元/构建测试通过；npm run build 通过，保留已有 Monaco 大包及桥接混合导入提示。
- npm run test:e2e：36 项 Chromium 交互通过，无跳过；额外迁移/绑定/语言定向测试已纳入上述单测。实际目视检查属性、粘贴和双窗口 JSON 界面，以及 1440×1000/1100×760 右键菜单。
- cargo test --workspace：65 项常规测试通过；npm run test:c：14 项真实 C 测试通过；同源 aliases.c 重新构建 AOT 后，JIT/AOT 别名与原子写入合同通过。
- 最终 npx tauri build --debug --bundles app 通过，生成 target/debug/bundle/macos/QuickGUI.app（67.12 MiB），包含最后的资源优先级修复；重新准备的 C worker 宣告 ABI 2、compileCheck 与 variableAliases 能力。独立 v3 多窗口/JSON/图表/表格/React/C 别名工程已实际导出，npm ci 与生产构建通过；导出 TSX 修改后按本地模块 ID 重建和原子回填成功。
- 独立目录 cargo check --workspace 通过；独立生产构建的 8 项浏览器检查验证双窗口 JSON/React 同步、表格路径写入/排序、图表采样和窗口流程重开，无页面异常或设计器开发服务器依赖。包内 worker 从工作区外目录 self-test 成功；同源 C 在包内 JIT 和独立 AOT 的 output/state/writes 一致。构建生成的 icon.icns 已恢复原版本，本轮未打独立应用安装包或验证分发签名。
- 集成中发现的属性路径、语言回退、旧控件迁移、名称绑定、运行值提交时序与内嵌资产覆盖问题已修复并增加回归；新增 Rust 测试借用错误及测试预期差异已修正，复跑通过。
- Prettier、cargo fmt 与 Git 差异检查通过。系统剪贴板成功路径/跨进程、原生系统窗口自动点击、Windows/Intel Mac、签名公证、物理设备及耐久/性能验收未执行；不以浏览器、回环或开发态测试替代这些验证。生成物按忽略规则处理。

## 2026-10-18 — v3 运行数据与脚本映射基础

- 为后续编辑器升级建立 v3 类型、控件属性描述和运行数据接口；JSON 变量支持 1 MiB/32 层限制、原子现有路径写入、根路径兼容和持久化。v3 运算与条件语义在浏览器/Rust 间统一，旧版本保留原路径。
- 历史查询增加批量时间范围、原始样本或 avg/min/max/last 分桶，空桶和截断明确；只采样声明为 number 的变量，复用 SQLite 并增加时间索引。
- C 源码与 ABI 2 保持不变，worker 增加 variableAliases 能力与封闭名字映射；同一变量的多别名使用同一写槽。直接脚本执行新增统一 runScript 接口，写集和状态整批验证后提交。
- 增加主设计器窗口限定的原生剪贴板读写命令，文本上限 30 MiB；新增 tauri-plugin-clipboard-manager 2.x 依赖及锁定记录。
- 新增 `src/core/jsonValue.ts`、`src/core/widgetDefinitions.ts`：安全 JSON 操作与下一阶段 UI 共用的属性定义。
- 修改 `src/core/types.ts`：v3、JSON/路径、属性版本、编辑状态、资源作用域、组件身份、历史 DTO 和脚本别名类型。
- 修改 `src/runtime/engine.ts`、`src/runtime/controller.ts`、`src/runtime/windowState.ts`、`src/native/bridge.ts`：数据、历史、脚本及剪贴板接口。
- 新增 `crates/quickgui-engine/src/json_value.rs`、`crates/quickgui-engine/src/history/range.rs`；修改 `crates/quickgui-engine/src/types.rs`、`crates/quickgui-engine/src/lib.rs`、`crates/quickgui-engine/src/windows.rs`、`crates/quickgui-engine/src/history.rs`、`crates/quickgui-engine/src/worker.rs`：原子读写、v3 校验、历史聚合与能力检查。
- 修改 `crates/quickgui-c-runner/src/main.rs`、`crates/quickgui-c-runner/tests/execution.rs`、`sdk/quickgui.h`：别名协议、兼容调用及测试适配。
- 新增 `crates/quickgui-c-runner/tests/aliases.rs`、`sdk/tests/aliases.c`、`sdk/tests/README.md`、`tests/runtime-v3.test.ts`：JSON、持久化、历史边界和真实 JIT/AOT 合同验证及复现说明。
- 修改 `src-tauri/Cargo.toml`、`Cargo.lock`、`src-tauri/src/lib.rs`、`src-tauri/src/history.rs`：原生命令、代际校验及剪贴板依赖。修改 `CHANGELOG.md` 记录本组变化；无源文件删除或重命名。
- 专项验证：相关 33 项 TS 测试、Rust workspace 64 项常规测试、14 项真实 C 测试通过；同源别名/原子写入合同已分别在本机 JIT 与 macOS ARM64 AOT 执行通过。其余默认忽略的专项未用常规测试冒充。编辑器界面整合与最终打包在后续逻辑变更验证。
- 提交边界复核：从 Git 索引导出独立源码快照，`npm run check` 的 TypeScript 与 136 项单测通过，确认本组不依赖尚未提交的编辑器界面改动。

## 2026-10-18 — 合并画布标题与工具栏

- 将 `qg-canvas-toolbar` 的网格、吸附、缩放、100% 重置和适应画布操作合并到唯一的 `canvas-heading`，原两行改为一行，窗口尺寸只显示一次。
- 保留当前窗口/模块标题与退出模块入口；长标题省略并提供完整提示，窄窗口压缩非交互状态文字，给操作按钮留出空间。
- 修改 `src/App.tsx`：通过 heading 内容传入画布标题及模块操作，移除重复标题行。
- 修改 `src/designer/CanvasEditor.tsx`：统一标题栏与画布工具，保持原有画布状态和事件处理。
- 修改 `src/styles.css`：单行布局、标题省略与窄窗口规则。
- 修改 `src/designer/designer.css`：移除旧独立工具栏及其响应式样式。
- 修改 `CHANGELOG.md`：记录本次布局变更；无源文件新增、删除、重命名或工程格式/依赖变更。
- 验证：`npm run check` 的类型检查及 129 项单测、`npm run build`、21 项浏览器 E2E 均通过；`cargo test --workspace` 的 57 项常规测试通过，11 项显式忽略的 C 测试本轮未执行，本次未改原生或 C 逻辑。构建保留已有 Monaco 大包与混合导入提示。
- 浏览器实际检查 1440/1100px、亮/暗主题、中/英文及长窗口/模块名共 16 个场景：标题栏保持 43px 单行，无横向溢出；网格、吸附、缩放、100% 重置、适应画布和模块退出正常，无页面异常，截图已目视复核。
- `npx tauri build --debug --bundles app`、Prettier 与 Git 差异检查通过，更新 `target/debug/bundle/macos/QuickGUI.app`（63.38 MiB）。本轮布局通过浏览器验收，未另做原生系统 UI 点击验收。

## 2026-10-18 — 同一 HMI 工程多窗口

### 目的与行为

- 支持固定主窗口与最多 31 个附加窗口：新增、切换、重命名、删除确认、独立布局/属性/图标、启动开关、撤销重做及活动窗口恢复。
- 控件增删改、复制、模块实例与变量/流程引用检查覆盖对应窗口；窗口切换保留 CODE 草稿，含未应用草稿或流程引用的窗口不能直接删除。
- 新增“窗口操作”流程节点，支持打开、聚焦、关闭附加窗口。窗口共享变量与业务流程，重复打开复用窗口，关闭附加窗口保留共享值与调度。
- 浏览器使用可拖动的多窗口预览工作区；桌面及独立运行应用使用原生窗口。用户预览打开当前窗口，后续热更新保留人工关闭状态。
- 原生子窗口只连接 preview 运行会话，共享 Engine、定时源和 SQLite，保留各自请求代际；全组关闭取消待处理任务，过期同步票据不能重开窗口。位置按工程及窗口分别记录，普通热更新不抢焦点。
- v1 工程原样读写；使用附加窗口或窗口节点时升级为 v2。v2 保留主窗口字段，新增 windows 数组；旧设计器拒绝版本号，未知字段和无效引用不会静默丢弃。原始工程、CLI/原生源码导出均保留完整窗口定义。
- 浏览器重复应用同一工程修订号不会取消在途启动流程或重复启动；子原生视图不重复编译、初始化或停止共享会话。

### 源文件操作

- 新增 `src/core/windows.ts`：窗口枚举、访问及仅用于渲染的投影。
- 新增 `src/panels/WindowManager.tsx`：窗口管理列表及创建/重命名/删除弹窗。
- 新增 `src/runtime/RuntimeWindows.tsx`、`src/runtime/windowState.ts`：浏览器窗口工作区及共享可见状态。
- 新增 `crates/quickgui-engine/src/windows.rs`：原生窗口格式、引用与动作校验、状态迁移。
- 新增 `src-tauri/src/windows.rs`：原生窗口路由、同步计划、视图代际及分窗口位置存储。
- 新增 `tests/project-windows.test.ts`、`tests/project-windows-store.test.ts`、`tests/multi-window-runtime.test.ts`、`tests/native-window-controller.test.ts`、`tests/e2e/multi-window.spec.ts`：格式、编辑恢复、共享运行状态、子视图连接与真实浏览器交互回归。
- 修改 `src/core/types.ts`、`src/core/validation.ts`、`src/core/archive.ts`、`tests/project-compatibility.test.ts`：v1/v2 契约、所有窗口内容校验及归档版本说明。
- 修改 `src/core/store.ts`、`src/App.tsx`、`src/styles.css`：当前窗口编辑状态、管理入口、预览和跨窗口引用保护。
- 修改 `src/designer/FlowEditor.tsx`：窗口节点配置与目标选择。
- 修改 `src/runtime/engine.ts`、`src/runtime/controller.ts`、`src/runtime/RuntimeApp.tsx`、`src/runtime/runtime.css`、`src/native/bridge.ts`：窗口动作、共享数据和原生子视图连接。
- 修改 `crates/quickgui-engine/src/types.rs`、`crates/quickgui-engine/src/lib.rs`：窗口模型、快照、流程动作与状态回归。
- 修改 `src-tauri/src/lib.rs`、`src-tauri/src/history.rs`、`src-tauri/src/close_project_tests.rs`、`src-tauri/capabilities/main.json`：组生命周期、共享历史、独立视图代际及窗口权限。
- 修改 `scripts/export-project.mjs`、`src-tauri/src/source_export.rs`、`templates/runtime/src/main.tsx`：完整多窗口源码交付及独立运行入口。
- 修改 `templates/runtime/package-lock.json`：同步现有 esbuild `^0.28.2` 声明，修复独立导出工程的 `npm ci` 锁文件不一致错误，并去重相同版本的间接包；未新增依赖或改动依赖声明。
- 修改 `README.md`、`docs/architecture.md`、`docs/project-compatibility.md`、`docs/verification.md`、`CHANGELOG.md`：使用方式、共享会话、兼容性与验证说明。
- 无源文件删除或重命名；v2 工程需本次多窗口能力对应的设计器/运行代码。

### 验证与限制

- `npm run check`：TypeScript 检查与 129 项单元测试通过。初次全量检查中旧重复 ID 错误消息断言失败，保留 Duplicate 标识后复核通过。
- `npm run build`、`npm run test:e2e`：生产构建及 21 项真实浏览器测试通过，覆盖窗口创建/切换/属性/模块、草稿保护、导出重开、共享值、标题拖动、真实控件事件经窗口流程节点开关子窗口。
- `cargo test --workspace -- --include-ignored`：34 项引擎、20 项原生宿主及 14 项 runner/C 测试全部通过，包含真实 C 关闭取消。子任务环境曾禁止 localhost bind，已在当前环境复核全部协议回环通过。
- 独立多窗口工程实际重新导出后 `npm ci`、`npm run build`、`cargo check --workspace` 通过。第一次 `npm ci` 因既有模板锁文件与 esbuild 声明不一致失败，同步模板锁后重新导出、安装和构建成功；本次安装审计为 0 个已知漏洞，沿用 npm 的安装脚本策略，未扩大脚本授权。
- 实际运行独立前端生产构建，验证子窗口双向输入同步主窗口、流程打开窗口、关闭重开保留共享值，无页面异常。
- `npx tauri build --debug --bundles app` 通过，更新 `target/debug/bundle/macos/QuickGUI.app`（63.38 MiB）。保留既有 Monaco 大包及混合导入构建提示。
- Prettier、Rust 格式检查与 Git 差异检查通过。截图已目视核验浏览器多窗口布局；原生系统多窗口自动点击、Windows/Intel Mac 实机、签名公证与耐久验收未执行。独立源码已做前端构建和原生编译检查，本轮未另打独立应用安装包。

## 2026-10-18 — 提交身份使用本机 Git 配置

- 按用户要求，将已有 3 条本地提交的作者及提交者从 `Codex <codex@localhost>` 更新为 `ayu-z <yuzuihong@live.com>`。本机未设置全局 name/email，本次使用当前仓库已有的明确配置，未改写任何 Git 身份配置；后续提交直接使用 Git 配置。
- 原提交文件树、说明、作者/提交时间及历史顺序逐项核对一致，仅身份及关联提交哈希变化：`a176192` → `ae414e4`、`0abe99d` → `f9ddf0b`、`8aebda5` → `c820b91`。
- 旧历史备份位于 `.git/identity-backups/20261018-122213-8aebda5.bundle`，配套 JSON 记录完整哈希映射；`git bundle verify` 通过。仓库未配置远端，本次无推送。
- 源文件操作：仅修改 `CHANGELOG.md` 记录本次身份调整，无其他源文件新增、修改、删除或重命名。
- 验证：提交元数据、父提交映射和文件树比对通过，重写后工作区干净；应用内容未变，本次不重复运行应用测试或打包。

## 2026-10-18 — 修复按钮悬停白底白字

### 目的与行为

- 修复普通按钮悬停选择器覆盖主按钮背景的问题。亮色主题原先叠加 `brightness(1.1)` 后形成白底白字；主按钮现在使用独立的紫色悬停背景和边框，保留白色文字，不再整体提亮。
- 修复亮色设计器中流程缩放按钮悬停时白底白图标的问题。React Flow 的悬停背景与文字颜色统一取设计器主题变量，不再混用工程主题的默认白色图标。
- 普通按钮和禁用按钮保留各自状态；无工程格式、依赖、配置或迁移变更。

### 源文件操作

- 修改 `src/styles.css`：亮/暗主题主按钮悬停色、普通与主按钮的选择器范围。
- 修改 `src/designer/designer.css`：补齐 React Flow 悬停颜色变量，删除冲突的背景覆盖规则。
- 修改 `CHANGELOG.md`：记录原因、修复及验证。本次无源文件新增、删除或重命名。

### 验证与限制

- 浏览器实际悬停核验亮/暗主题的导出、重命名确认、保存并关闭、普通预览按钮及禁用确认按钮，计算样式均符合主题；截图目视核验白色文字在紫色背景上清晰可见。
- 流程页放大、缩小、适配视图共 6 次亮/暗主题悬停复核通过：亮色为浅灰底深色图标，暗色为深灰底浅色图标；截图确认清晰，无页面异常。
- `npm run check`：类型检查与 67 项单元测试通过。
- `npm run test:e2e`：16 项浏览器交互测试通过。
- `npm run build` 与 `npx tauri build --debug --bundles app`：通过，macOS 调试包已更新至 `target/debug/bundle/macos/QuickGUI.app`（61.56 MiB）；保留既有 Monaco 大包及混合导入提示。
- `cargo test --workspace`：39 项常规测试通过；11 项显式忽略的 C 测试本轮未执行，本次仅修改设计器 CSS。
- Prettier 与 `git diff --check` 通过。原生系统 UI、Windows/Intel Mac 实机本轮未验收。

## 2026-10-18 — 新建命名与工程重命名

### 目的与行为

- 欢迎页及工程菜单的新建入口先填写工程名称，再创建空工程；有当前工程时沿用保存/恢复副本/取消的安全关闭流程。
- 增加“工程名称 → 重命名工程”，自动保存并支持撤销、导出和恢复。重命名保留工程 ID、窗口标题、发布应用名与控件内容。
- 命名去除首尾空格，拒绝空名称、超过 200 字符或包含控制字符的输入；支持中英文、Enter 确认、Escape 取消与弹窗内 Tab 焦点循环。
- 浏览器下载与原生保存对话框使用工程名作为建议文件名，处理路径符号、Windows 保留名称及 UTF-8 长度；仅调整建议文件名，工程内名称完整保留。

### 源文件操作

- 新增 `src/panels/ProjectNameDialog.tsx`：可复用的创建/重命名弹窗及输入、键盘校验。
- 新增 `tests/e2e/project-name.spec.ts`：命名、取消、键盘、导出文件、自动保存与恢复回归。
- 修改 `src/App.tsx`：工程菜单入口、新建安全关闭衔接、重命名及建议导出文件名。
- 修改 `src/panels/WelcomeScreen.tsx`：欢迎页新建工程命名入口。
- 修改 `src/styles.css`：命名弹窗布局与校验样式。
- 修改 `src/core/archive.ts`、`tests/core.test.ts`：跨平台建议文件名及完整工程名称保留验证。
- 修改 `src-tauri/src/lib.rs`、`src-tauri/src/project_file.rs`：原生保存建议名称、特殊字符与 UTF-8 边界测试。
- 修改 `tests/e2e/project-close.spec.ts`：新建时增加命名确认步骤。
- 修改 `README.md`、`docs/verification.md`、`CHANGELOG.md`：使用说明与本次验证记录。
- 无源文件删除或重命名，无依赖、工程 schema 或迁移变更。

### 验证与限制

- `npm run check`：类型检查与 67 项单元测试通过。
- `npm run build`：通过；保留已有 Monaco 大包及原生桥接静态/动态混合导入提示。
- `npm run test:e2e`：16 项浏览器测试通过。实际下载并解压 `.qgui`，验证新名称及工程 ID/窗口/发布配置不变；截图检查命名弹窗布局。
- `cargo test --workspace`：23 项引擎、12 项原生宿主、4 项 runner 常规测试通过；11 项显式忽略的真实 C/原生 C 测试本次未执行，本次未改 C、SDK 或执行协议。
- `cargo fmt --all --check`、`git diff --check`：通过。
- `npx tauri build --debug --bundles app`：通过，更新 `target/debug/bundle/macos/QuickGUI.app`（61.56 MiB）。
- 原生保存文件名算法已测试，原生系统保存对话框未做实际点击验收；Windows/Intel Mac、签名公证及耐久验证仍未完成。

## 2026-10-18 — 关闭工程与兼容性保护

### 行为

- 增加“关闭工程”及空工作区，支持取消、保存文件后关闭、保留本机恢复副本；未应用的 CODE 草稿可关闭后恢复。新建从空窗口开始，刷新后保持关闭状态。
- 新建/打开替换当前工程时先执行关闭流程，避免旧同 ID 工程的运行状态和请求混入新工作区。
- 原生关闭取消主窗口与预览的 C、校验、连接、流程、定时器和构建任务，等待退出并确认 SQLite 最后写入成功，再清会话和关闭预览；源文件、历史数据库保留。
- 使用工程代号、客户端代际和事件过滤阻止迟到操作重新启动已关闭工程；持久化失败保留停止状态供重试。
- 仍只支持 schemaVersion=1。明确拒绝未知格式/结构字段，列出字段路径，防止读取后静默丢字段；没有引入新的工程格式或伪称实现迁移链。
- 说明 JSON 已内嵌源码/资源但依赖内置运行实现，长期归档应保留工程包、独立源码包、运行包及对应设计器版本。

### 源文件操作

- 新增 `src/panels/WelcomeScreen.tsx`：关闭后的欢迎页、新建/打开/恢复入口。
- 新增 `src-tauri/src/close_project_tests.rs`：关闭、刷新失败、迟到请求、真实 C 取消回归。
- 新增 `tests/project-close.test.ts`：恢复、草稿、缓存写入失败及关闭状态回归。
- 新增 `tests/project-compatibility.test.ts`：版本、未知字段、输入不变和开放配置测试。
- 新增 `tests/native-bridge.test.ts`：工程代际与关闭期间的桥接行为。
- 新增 `tests/e2e/project-close.spec.ts`：取消/关闭/刷新/恢复/保存/新建及不兼容导入交互。
- 新增 `docs/project-compatibility.md`：现有保障、实际缺口和长期归档建议。
- 修改 `src/App.tsx`、`src/core/store.ts`、`src/core/project.ts`、`src/styles.css`：可空工程、关闭确认、恢复副本、工作区生命周期及空工程创建。
- 修改 `src/runtime/controller.ts`、`src/runtime/engine.ts`：停止/关闭接口和迟到任务阻断。
- 修改 `src/native/bridge.ts`、`src-tauri/src/lib.rs`、`src-tauri/src/build_runtime.rs`：原生取消域、代际校验及预览关闭。
- 修改 `src-tauri/src/history.rs`：最终落库操作返回真实事务结果，错误能够阻止关闭。
- 修改 `src/core/validation.ts`：明确格式错误及固定结构严格校验。
- 修改 `tests/native-controller.test.ts`、`tests/e2e/designer.spec.ts`：候选编译关闭竞态、关闭失败重试及工程切换流程。
- 修改 `crates/quickgui-c-runner/tests/execution.rs`：普通功能测试预算从1秒调至5秒、崩溃测试10秒；100ms超时/取消及耗时断言保持原样，生产逻辑不变。
- 修改 `README.md`、`docs/verification.md`、`CHANGELOG.md`：使用方式、兼容性边界与验证记录。
- 修改 `crates/quickgui-c-runner/Cargo.toml`、`crates/quickgui-engine/Cargo.toml`：清理提交检查发现的文件末尾空白，依赖声明不变。
- 无源文件删除或重命名。

### 验证与限制

- npm run check：类型检查及66项单测通过。
- npm run test:e2e：12项浏览器交互测试通过。
- cargo test --workspace -- --include-ignored：23项引擎、14项真实C、12项原生宿主测试通过。
- npm run build：通过；沿用已有 Monaco 主包体积提示。
- 全量验证第一次触发旧C功能测试1秒预算超时；定向未复现。仅提高功能测试预算后完整通过，没有修改生产超时策略，不能确定归因于系统崩溃报告器。
- macOS调试包已更新：`target/debug/bundle/macos/QuickGUI.app`（61.53 MiB）。Windows/Intel实机、签名公证和72小时耐久验证仍未完成。

### Git

本轮开始时仓库已初始化、尚无历史提交。此次提交包含同一会话此前生成的工程基础和本轮修改；以 Codex 自动提交身份建立首个本地提交，不设置全局 Git 身份，不推送远端。

## 2026-10-18 — QuickGUI 0.1 初始实现

### 目的与范围

从空工作区建立跨平台 HMI 设计器：控件级 UI/CODE 属性及样式编辑、原生窗口和图标、通用组件、流程绑定、C SDK、通信驱动、热更新、SQLite 历史报警及独立源码/应用交付。

### 行为与接口

- 控件属性/样式代码独立于页面结构，严格 JSON 校验、按控件保存无效草稿、统一撤销与恢复。
- 支持容器树复制/删除和组合模块；React 组件包保留 TSX/CSS 源码、受信导入、ShadowRoot 样式隔离和声明事件。
- 原生窗口配置包含标题、大小、约束、位置恢复、圆角偏好与图标；发布生成 ICO/ICNS 和 Windows 快捷方式配置。
- Rust DAG 引擎按事件和逐输入消息执行；支持定时、分支、变量、C、HTTP、通用连接和事件输出。
- C SDK ABI v2 支持数字/JSON/字符串 I/O，独立进程、超时、取消、原子写集及可序列化数字状态；预览 libtcc 与发布 AOT 共用 runner。
- 固定 TinyCC 源码按 ONE_SOURCE=yes 构建，修复 macOS 系统框架符号碰撞引起的 SIGBUS。
- C 热更新先走不执行用户代码的 compile-check，再原子应用；失败保留旧工程与诊断。执行器能力握手拒绝缺少 compileCheck 标志的旧版本，未知 CLI 参数明确报错。
- HTTP/WebSocket/MQTT/TCP/串口提供真实原生协议路径；SQLite 保存持久变量、差异采样、日志与报警确认。
- 预览/运行会话隔离，启动与停止串行；epoch 和 projectId/revision/sequence 阻止旧命令、旧快照覆盖新工程。
- 提供原始 qgui ZIP、独立 React/Rust/C 源码、标准构建脚本、组件源码重建和本机应用构建。

### 验证

- npm run check：TypeScript 检查通过，33 项单元测试通过。
- npm run test:e2e：8 项真实浏览器交互测试通过。
- cargo test --workspace -- --include-ignored：23 项引擎、14 项真实 C、7 项原生宿主测试全部通过。
- JIT 与 AOT 已实际执行数字、字符串和嵌套 JSON；源码哈希不匹配会被拒绝。
- HTTP/TCP/WebSocket/MQTT 本机回环通过；串口缺设备错误通过，未对物理设备发送数据。
- 独立源码工程重新安装依赖、前端构建、cargo check 和 AOT 应用打包已验证；从导出 TSX 源码重建组件包通过。
- npm audit --omit=dev：0 个已知生产依赖漏洞。
- 最新 `npx tauri build --debug --bundles app` 成功：`target/debug/bundle/macos/QuickGUI.app`（61.29 MiB）。从 `/private/tmp` 运行包内 runner 自检成功，capabilities 确认使用包内 libtcc 且 hostAbi=2，无需依赖工作区工具链路径。

### 兼容性与发布边界

- 本机验证平台为 macOS ARM64；Windows x64、macOS Intel 尚未实机验证，CI 仅定义了对应矩阵。
- 未完成签名/公证环境下 JIT 验收、72 小时耐久测试及规划性能基准。
- 电脑控制工具拒绝操作新生成的 Pump Station 应用，原生窗口自动点击未验证；不以浏览器 E2E 替代该项。
- ABI v2 保持数字 API 兼容；数字变量写集和模块状态不扩展为任意内存快照。
- 原始工程可往返编辑；独立开发源码为单向导出。

### Git 状态

本阶段结束时工作区尚未初始化，因此当时未创建提交。下一阶段检测到仓库已初始化，将此前工程基础与后续已验证改动建立首个本地提交。

### 源文件操作清单

基线为空工作区，下列 110 个文件均为新增；本次无既有源文件删除或重命名。生成缓存、构建产物、运行库暂存和截图由 .gitignore 排除。

#### 工程与构建基础

- 新增 `.github/workflows/build.yml`
- 新增 `.gitignore`
- 新增 `.prettierignore`
- 新增 `.prettierrc.json`
- 新增 `Cargo.lock`
- 新增 `Cargo.toml`
- 新增 `index.html`
- 新增 `package-lock.json`
- 新增 `package.json`
- 新增 `playwright.config.ts`
- 新增 `scripts/build-aot.mjs`
- 新增 `scripts/build-component.mjs`
- 新增 `scripts/build-native.mjs`
- 新增 `scripts/export-project.mjs`
- 新增 `scripts/icons.mjs`
- 新增 `scripts/setup-tcc.mjs`
- 新增 `templates/runtime/.gitignore`
- 新增 `templates/runtime/CMakeLists.txt`
- 新增 `templates/runtime/README.md`
- 新增 `templates/runtime/index.html`
- 新增 `templates/runtime/package-lock.json`
- 新增 `templates/runtime/package.json`
- 新增 `templates/runtime/src/main.tsx`
- 新增 `templates/runtime/tsconfig.json`
- 新增 `templates/runtime/vite.config.ts`
- 新增 `tsconfig.json`
- 新增 `vite.config.ts`
- 新增 `vitest.config.ts`

#### 控件设计器与运行界面

- 新增 `public/quickgui.svg`
- 新增 `src/App.tsx`
- 新增 `src/core/archive.ts`
- 新增 `src/core/componentPackage.ts`
- 新增 `src/core/i18n.ts`
- 新增 `src/core/project.ts`
- 新增 `src/core/store.ts`
- 新增 `src/core/types.ts`
- 新增 `src/core/validation.ts`
- 新增 `src/designer/CanvasEditor.tsx`
- 新增 `src/designer/CodeEditor.tsx`
- 新增 `src/designer/Fields.tsx`
- 新增 `src/designer/FlowEditor.tsx`
- 新增 `src/designer/Inspector.tsx`
- 新增 `src/designer/Library.tsx`
- 新增 `src/designer/WindowInspector.tsx`
- 新增 `src/designer/designer.css`
- 新增 `src/main.tsx`
- 新增 `src/native/bridge.ts`
- 新增 `src/panels/ConnectionsPanel.tsx`
- 新增 `src/panels/HistoryPanel.tsx`
- 新增 `src/panels/ProjectSettings.tsx`
- 新增 `src/runtime/CustomComponent.tsx`
- 新增 `src/runtime/RuntimeApp.tsx`
- 新增 `src/runtime/WidgetRenderer.tsx`
- 新增 `src/runtime/controller.ts`
- 新增 `src/runtime/engine.ts`
- 新增 `src/runtime/runtime.css`
- 新增 `src/styles.css`

#### Rust运行引擎、C执行器和原生宿主

- 新增 `crates/quickgui-c-runner/Cargo.toml`
- 新增 `crates/quickgui-c-runner/build.rs`
- 新增 `crates/quickgui-c-runner/src/main.rs`
- 新增 `crates/quickgui-c-runner/tests/execution.rs`
- 新增 `crates/quickgui-engine/Cargo.toml`
- 新增 `crates/quickgui-engine/src/connections.rs`
- 新增 `crates/quickgui-engine/src/history.rs`
- 新增 `crates/quickgui-engine/src/lib.rs`
- 新增 `crates/quickgui-engine/src/types.rs`
- 新增 `crates/quickgui-engine/src/worker.rs`
- 新增 `sdk/README.md`
- 新增 `sdk/THIRD_PARTY.md`
- 新增 `sdk/aot/CMakeLists.txt`
- 新增 `sdk/aot/example.c`
- 新增 `sdk/aot/json-example.c`
- 新增 `sdk/quickgui.h`
- 新增 `src-tauri/Cargo.toml`
- 新增 `src-tauri/build.rs`
- 新增 `src-tauri/capabilities/main.json`
- 新增 `src-tauri/icons/128x128.png`
- 新增 `src-tauri/icons/128x128@2x.png`
- 新增 `src-tauri/icons/32x32.png`
- 新增 `src-tauri/icons/64x64.png`
- 新增 `src-tauri/icons/app.svg`
- 新增 `src-tauri/icons/icon.icns`
- 新增 `src-tauri/icons/icon.ico`
- 新增 `src-tauri/icons/icon.png`
- 新增 `src-tauri/resources/c-runner/README.txt`
- 新增 `src-tauri/src/build_runtime.rs`
- 新增 `src-tauri/src/history.rs`
- 新增 `src-tauri/src/lib.rs`
- 新增 `src-tauri/src/main.rs`
- 新增 `src-tauri/src/project_file.rs`
- 新增 `src-tauri/src/scheduler.rs`
- 新增 `src-tauri/src/source_export.rs`
- 新增 `src-tauri/tauri.conf.json`

#### 示例、测试与文档

- 新增 `AGENTS.md`
- 新增 `CHANGELOG.md`
- 新增 `README.md`
- 新增 `THIRD_PARTY_NOTICES.md`
- 新增 `docs/architecture.md`
- 新增 `docs/verification.md`
- 新增 `examples/components/status-card/README.md`
- 新增 `examples/components/status-card/manifest.json`
- 新增 `examples/components/status-card/src/StatusCard.tsx`
- 新增 `examples/components/status-card/src/sdk.ts`
- 新增 `examples/components/status-card/src/styles.css`
- 新增 `examples/pump-station/quickgui.json`
- 新增 `tests/component-package.test.ts`
- 新增 `tests/core.test.ts`
- 新增 `tests/e2e/components.spec.ts`
- 新增 `tests/e2e/designer.spec.ts`
- 新增 `tests/native-controller.test.ts`
