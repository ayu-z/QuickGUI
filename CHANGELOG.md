# 变动日志

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
