# 变动日志

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
