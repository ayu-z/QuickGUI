# USB 助手

欢迎页选择“打开 USB 助手示例”，或打开本目录的 `quickgui.json`。这是普通可编辑 v5 工程，使用当前控件与 FB 接口。

全部操作整合为“USB 助手 · 设备发现与通信”一张流程图，仅包含一个设备发现 FB 和一个通信 FB。扫描、打开、关闭和发送按钮绑定同一流程的不同事件入口，异步 RX/TX/STATE 与错误直接从共享 FB 输出处理。在控件“事件与流程”中可分别修改流程和入口。

1. 桌面运行时点击“扫描 / 监听”，发现块返回完整列表并监听热插拔。
2. 选择精确设备，再点击“打开”。初始选择为空，不按 VID/PID 自动选择首台设备。
3. 输入十六进制载荷并点击“发送 HEX”；异步 RX、TX、STATE 分别从通信 FB 的对应输出口继续执行。
4. 点击“关闭”释放 `usb-main` 会话，改动流程或关闭工程同样回收资源。

USB 基于 [usb_comm_rs](https://github.com/dev-zuihong/usb_comm_rs)，依赖固定到当前修订以保证构建可复现，Rust 需要 1.88 或更新版本。支持 HID 和 Windows `usbprint.sys` 原始通信；不提供通用 WinUSB/libusb Bulk。USB Print 使用库的包大小及 ZLP 行为。

HID 默认 Report ID 为 0、无编号输入报告。可在通信 FB 中设置 `reportId`，并在打开节点的 `options` 中设置 `numberedInputReports`。通信 FB 还提供 `FEATURESEND`、`FEATUREGET` 和 `DESCRIPTOR` 命令口，结果从对应输出口返回。

发现块的 `filter` 接受 `transport`（`any` / `hid` / `usbPrint`）、数字 `vendorId` / `productId`、`serialNumber`、`usagePage` / `usage`。设备对象保留原始路径与连接代次；重新插入或重启运行时后应重新发现并选择。

浏览器点击扫描、打开或发送会显示 `NATIVE_USB_REQUIRED`，不会生成设备或收发数据。仓库测试覆盖真实系统枚举、监听回收与流程语义；实体 HID / USB Print 收发需要使用实际设备验证。
