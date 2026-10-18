# 验证记录

## 串口助手与 v4 流程验证（2026-10-19）

- macOS ARM64：`npm run check` 的 TypeScript 检查及 233 项测试通过；`npm run build` 与 45 项 Chromium E2E 通过。覆盖 v4 显式升级/撤销、源文件往返、ValueRef、map/append、VID/PID 过滤、依赖复制与引用保护、受控定时器、并行流程/C 状态、原生桥接代际与浏览器能力诊断。
- 最新计数流程修复后，重跑 233 项单测及 4 项串口 E2E 均通过；原生最终快照冻结后 `cargo test --workspace` 的 95 项常规测试通过（引擎 67、宿主 24、runner 4），默认忽略的 13 项环境条件测试另行执行，不计入常规通过数。
- 实际从 `examples/serial-assistant/quickgui.json` 导出最终独立源码至 `artifacts/serial-standalone-verified`，`npm ci --ignore-scripts`、生产构建及 `cargo check --workspace` 通过。CLI 和原生嵌入源码清单包含 `src/examples`，避免 `src/core/examples.ts` 的依赖缺失。
- 最终独立生产站点在 4380 端口通过 Playwright 实测：64 个通用控件、默认 115200、关闭时发送/定时发送禁用、扫描显示原生能力诊断、只有占位端口选项、无虚假记录且计数为零。无页面异常、console.error 或设计器开发资源请求；截图/请求记录在忽略的 `artifacts/serial-standalone-verified-browser.*`。此前 4379 端口的独立导出也通过同类检查，另行直接执行导出运行时确认诊断码为 `NATIVE_SERIAL_REQUIRED`。
- `npm run test:c`：14 项真实 C 测试通过；同源 aliases 的 JIT/AOT 合同测试通过，包含 v4 四次并发调用的 state.runs=1/2/3/4、变量递增和失败回滚。`close_cancels_a_real_inflight_c_worker` 通过。C ABI 保持 2。
- `QG_SERIAL_DEMO_FIXTURE="$PWD/examples/serial-assistant/quickgui.json" cargo test -p quickgui-engine actual_demo_opens_a_real_pty_and_routes_rx_tx_state_without_widget_code -- --ignored --nocapture`：1/1 通过；实际加载最终工程及可视化流程，经操作系统 PTY 完成打开、RX/TX、监听、状态、热更新、关闭，覆盖停止监听仍计数、排队 RX/TX 后重置计数及记录保留。macOS PTY 重新打开时不支持串口 modem ioctl，测试适配器将真实预打开 slave 注册给生产打开路径，仅在 cfg(test) 下使用；未添加生产模拟驱动，也未打开物理串口。
- 17 项串口定向回归包含双重队列预算、溢出锁定、严格重连身份/参数锁定、租约释放、停止监听不重放、RX 分帧/TX 原文、部分写超时、关闭抢占、外观热更新、计数重置与显式数据快照、普通状态/数据公平投递、故障优先及发送错误保留。
- `npx tauri build --debug --bundles app` 通过，更新 `target/debug/bundle/macos/QuickGUI.app`（71.48 MiB）。包内 ICNS 与既有白底图标、包内 C worker 与暂存 worker 逐字节一致；从 `/tmp` 执行包内 worker self-test 返回 output=21/state.runs=1，ABI 2/compileCheck/variableAliases 可用且加载包内 libtcc。未另打独立应用安装包，未进行原生 UI 自动点击或分发签名验收。
- Prettier、`cargo fmt --all -- --check` 与 `git diff --check` 通过。测试首次发现的问题已修复并定向复跑：数据计数覆盖重置、隐式计数刷新破坏快照、普通状态通知挤占数据、旧状态错误覆盖新写入错误，以及导出遗漏示例源码。
- 不以浏览器回归或伪终端代替物理 USB、真实波特率/校验/流控、驱动热插拔及硬件重连验收。Windows/Intel Mac 实机、签名公证及长时间性能验收尚未执行。构建保留已有 Monaco 大包及桥接动态/静态混合导入提示。

执行环境：2026-10-18～19，macOS ARM64，Node 26、Rust 1.98、Apple Clang 21、CMake 4。

## v3 编辑与属性升级验证（2026-10-18）

- `npm run check`：TypeScript 与 195 项测试通过，覆盖迁移往返、版本拒绝、元数据/CODE 校验、事务多选、JSON 原子路径、跨工程依赖/复用、资源优先级、组件实际 esbuild 重建及失败时工程不变。
- `npm run build`：通过；保留已有 Monaco 大包及 bridge 动态/静态混合导入提示。
- `npm run test:e2e`：36 项 Chromium 浏览器测试通过，无跳过。包含滚轮锚点、平移/缩放/多选撤销、右键菜单及快捷键、升级取消/确认/撤销、同工程与跨工程粘贴、信任与依赖复用、属性及 JSON 输入、ID/名称和 `value`/`/value` 双窗口路径回写。
- 目视核验新版属性面板、粘贴审阅及共享 JSON 预览；1440×1000 与 1100×760 的画布边缘菜单完整可见，键盘首尾导航和取消正常。中文粘贴摘要、焦点循环及恢复有回归覆盖。
- `cargo test --workspace`：65 项常规测试通过；其中 41 项引擎、20 项宿主及 4 项 runner。默认忽略的测试另列，不计入常规通过数。
- `npm run test:c`：14 项真实 C 测试通过。重新构建 `sdk/tests/aliases.c` 的 macOS ARM64 AOT runner，再执行 `jit_and_aot_share_alias_and_atomic_write_contract`，同源 JIT/AOT 别名、读己之写、原子提交合同通过；ABI 保持 2。
- 集成检查发现并修复名称绑定读写不一致、属性路径与变量路径混用、动态语言回退、升级只改标记导致旧表格/选项语义变化、运行时接受新变量前允许编辑、内嵌图片被别名覆盖等问题。新增 Rust 导出测试的借用编译错误已修复；调整测试中的路径/副本名称预期后，最终检查全部通过。
- Prettier、`cargo fmt --all -- --check`、`git diff --check` 通过。截图、导出工程、原生资源暂存与测试日志均为忽略生成物。
- 最终 `npx tauri build --debug --bundles app` 通过，更新 `target/debug/bundle/macos/QuickGUI.app`（67.12 MiB）；最终包已包含剪贴板资源优先级修复。原生 C 资源重新准备，暂存 worker 能力报告为 ABI 2、compileCheck/variableAliases 可用，libtcc 从资源目录加载。
- 导出新的 v3 多窗口/JSON/曲线/表格/React/C 别名独立工程，`npm ci` 与 `npm run build` 通过；沿用现有安装脚本策略。修改导出 TSX 后，使用导出工具的 `--project/--module` 实际重建并回填 `project.json`，保留本地 ID、原包身份与资源，生成新的运行 bundle。
- 独立源码目录的 `cargo check --workspace` 通过。生产静态站点完成 8 项实际浏览器检查：双窗口 JSON/React 共享值、表格叶子写入及排序、曲线有限坐标采样、重建组件标记和本地交互、子窗口关闭/流程重开；无页面异常，也未请求设计器开发服务器。
- 最终应用包内 worker 与暂存 worker SHA-256 一致；从工作区外目录执行包内 worker，self-test 返回 output=21、state.runs=1，并加载包内 libtcc。同一份 aliases.c 在包内 JIT 与独立 AOT 执行均返回 output=21、state.runs=4、writes.native-count=21。未打独立应用安装包，未验收分发签名。

本轮浏览器测试未覆盖操作系统剪贴板成功读写或跨进程传递；原生命令具备窗口权限与大小限制，但不能据此声称系统剪贴板实机验收。原生窗口自动点击、Windows/Intel Mac 实机、签名公证、真实设备及长时间性能验收仍遵循下述边界。

## 已执行

- TypeScript 类型检查与生产前端构建。
- 工程往返、严格局部 CODE、非法引用/循环、流程分支、热更新取消、C 写入过期防护等单元测试。
- Rust 流程、稳定变量 ID、逐输入处理、热更新状态迁移与取消测试。
- 固定 TinyCC 的真实 C 编译、状态、输出、错误定位、死循环终止、崩溃后恢复测试。
- 同源 C 的 CMake/Clang 提前编译与独立 runner 执行。
- HTTP、TCP、WebSocket、MQTT 的本机回环协议测试；串口原生队列、PTY 与示例工程的执行结果见上方 v4 增量记录。
- 独立源码导出后重新安装依赖和构建；导出应用包含自己的原生宿主及 AOT C worker。

## 已发现并修正

TinyCC 多编译单元动态库的全局内部符号 `parse_flags` 与 Apple Heimdal 框架符号碰撞。在引入原生串口和系统证书依赖后，原先可执行的 libtcc 路径出现 SIGBUS。固定源码按上游 `ONE_SOURCE=yes` 构建后，内部符号不再参与此类解析；重新执行真实 C 测试。

## 验证边界

- Windows、Intel Mac 的本地实机运行尚未执行；CI 工作流覆盖对应架构，远端运行结果需实际运行工作流确认。
- 无开发者签名证书或公证凭据，未验证公开分发签名/公证。JIT 的开发终端测试不能代替 Hardened Runtime 分发验收。
- 电脑控制工具拒绝操作新生成的独立应用，因此原生窗口的自动点击验收未完成；浏览器交互、原生命令测试和实际打包分别记录，不能互相冒充。
- 尚未完成72小时耐久测试和方案中的吞吐/延迟基准；不声称达到这些发布指标。
- 真实物理设备、生产MQTT代理及平台串口驱动需在目标环境验收，回环测试仅验证实现协议路径。

初始实现验证结果：33 项 TypeScript/工程单测、8 项浏览器 E2E、23 项 Rust 引擎、14 项真实 C 和 7 项原生宿主测试通过。

本机 `target/debug/bundle/macos/QuickGUI.app` 已成功打包（61.29 MiB）。包内 C runner 从工作区以外目录运行 self-test 成功，返回 output=21、state.runs=1；capabilities 显示使用包内 libtcc、hostAbi=2。最终包还验证 compileCheck 能力和只编译不执行的行为。

完整源文件清单、命令结果及 Git 状态记录在 `CHANGELOG.md`。

## 关闭工程与兼容性增量验证（2026-10-18）

- 最新前端/桥接/恢复/兼容性单测66项、浏览器交互12项、Rust引擎23项、真实C测试14项、原生宿主12项通过。
- 覆盖未应用草稿关闭后恢复、重启保持空工作区、保存后关闭、未知字段拒绝、工程代际/迟到请求、真实C取消和最后事务失败时允许重试。
- C功能验证曾出现1秒预算超时，单项未复现；测试预算增加后全量通过。专门的100ms超时和取消验证未改变，生产超时策略未改变。

本轮 macOS 调试包已重新生成：`target/debug/bundle/macos/QuickGUI.app`（61.53 MiB），包含关闭工程和严格格式校验。

## 工程命名增量验证（2026-10-18）

- `npm run check`：67 项前端单测与类型检查通过；`npm run build` 通过。
- `npm run test:e2e`：16 项浏览器测试通过，包含新建/重命名、空白和长名拒绝、首尾空格归一化、弹窗焦点循环及 Escape/Enter、导出文件名与 JSON、自动保存和关闭后恢复。
- 重命名前后实际导出的工程 ID、窗口配置、发布配置和控件内容一致；新建替换仍经过安全关闭确认。
- `cargo test --workspace`：39 项常规测试通过，11 项显式忽略的 C 测试本轮未执行；C 源码、SDK、编译和执行协议未变更。
- 浏览器与原生建议文件名覆盖中文、路径符号、Windows 保留名称和 UTF-8 长度边界；完整工程名保存在工程内。
- 命名弹窗截图已目视核验；原生保存对话框未执行系统 UI 点击测试。
- `npx tauri build --debug --bundles app` 通过，macOS 调试包更新为 61.56 MiB，路径仍为 `target/debug/bundle/macos/QuickGUI.app`。

## 多窗口增量验证（2026-10-18）

- `npm run check`：129 项单元测试及 TypeScript 检查通过。
- `npm run build`、`npm run test:e2e`：生产构建与 21 项浏览器交互通过。多窗口用例覆盖独立布局、属性、模块、草稿/撤销保护、恢复、完整导出，以及从真实控件事件经窗口流程节点开关子窗口。
- `cargo test --workspace -- --include-ignored`：34 项引擎、20 项原生宿主、14 项 runner/C 测试全部通过。覆盖窗口引用、代际、关闭重开、旧销毁事件、全组清理及真实 C 取消；前期子任务环境限制的本地协议 bind 检查已在当前环境通过。
- 子原生控制器测试确认只订阅/连接共享运行时，不重复启动或编译；销毁子视图不会调用共享运行时停止/关闭。
- 独立源码重新安装依赖、前端生产构建和 `cargo check --workspace` 通过。修复测试发现的既有模板 esbuild 锁文件不一致问题，保留原依赖声明。
- 独立前端生产构建实际在浏览器运行，子窗口双向输入同步主窗口，流程重开后保留共享值，无页面异常。
- macOS 设计器调试包重新生成：`target/debug/bundle/macos/QuickGUI.app`（63.38 MiB）。本轮未另打独立应用安装包，也未进行原生多窗口自动点击、Windows/Intel Mac、签名公证或耐久验收。
