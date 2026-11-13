# Windows 浏览器与桌面验收入口

基线：33379e82589596fa37af53c93983115848a1f84f。设计已由用户批准。

本次增加真实 Chrome/Edge、浏览器协议确认、系统 URI handler、TLS 自动配对和 GUI/托盘生命周期矩阵，入口为 `pnpm test:browser`。
它不代替真实模型、多设备或跨用户验收，不把缺失桌面条件或跳过当作成功。

## 本地验证

- `pnpm test`：退出 0；71 文件通过、2 文件跳过，565 项测试通过、8 跳过。
- `pnpm typecheck`：退出 0。
- 原生 UIA helper 编译成功；本机检测交互桌面与 Explorer 托盘可用，Chrome/Edge 已安装。
- `pnpm test:browser --preflight`：因已有真实 URI owner 返回非零；核对前后 owner 未改变。这是安全拒绝证据，不是完整矩阵通过。
- 同次服务端插件归档可以在隔离 profile 中安装，真实 DSH Web 启动与正常退出 smoke 成功。
- 新增 URI app-data 回归在修复前出现 3 项失败，修复后通过；安装记录可选保存 LOCALAPPDATA，旧记录仍继承原环境。
- 独立复审指出两页互斥导致 GUI 展示断言错误，已改为真实点击导航分别验证连接页和 MCP 页；复审无剩余可确认 P1/P2。

## 运行和回收契约

构建专属客户端 EXE/runtime 经过现有记录与完整清单校验，服务端归档复制并绑定哈希后由两个浏览器共用。
只操作独立 profile、当前测试的 URI owner、刚导入的 CA 指纹、创建时间匹配的 PID 和唯一私有目录。
浏览器协议确认、窗口关闭和托盘动作使用真实输入，不模拟 Tray 事件。未知 owner、缺失桌面或失败清理均使验收非零退出。

截图只包含新测试 GUI 或经过 token 检查的页面视口；不上传地址栏、原始登录 URL、浏览器 profile、身份、CA 私钥或原始服务器日志。

完整矩阵的最终结论以本次提交对应的实际 GitHub Actions 运行及报告为准。当前本地拒绝、单元测试或服务端 smoke 不能替代该结果。

## 首轮 CI 反馈与确认修复

运行 [43417575963](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43417575963) 的桌面预检通过，
默认/开发/原生产物检查及打包均完成，但 CA 导入等待 Windows 安全确认而超时。
本机复现并通过只读检查确认该窗口属于测试 helper。修复为创建身份和映像路径固定的 UIA 确认，
同时覆盖导入、移除两个方向；原生指针点击先验证命中目标，防止背景或遮挡误点。
新生成测试 CA 的完整导入、确认、移除 smoke 均成功，类型检查通过，独立复审无新 P1/P2。

下一运行 [43420184132](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43420184132)
越过 CA 阶段，进程身份捕获遇到已退出的启动 PID。MCP SDK 的版本协商可以关闭初始子进程后
使用兼容驱动，因此标记不是“全部仍在运行”的清单。回归现区分退出标记、服务实际子树和存活的
未知 PID；二次启动比较当前子进程身份及前后标记增量，仍拒绝新进程或归属缺失。

运行 [43421631186](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43421631186)
到达 Chrome 设置导航。脱敏控件与截图显示新 profile 的 Internal Testing Notice 遮挡背景设置按钮。
新增正常引导：实际点击非约束性声明 Continue，若需要则通过 Configure later 延后模型配置；
每次浏览器点击增加命中检查，不能把后台按钮坐标当作前台可用控件。引导回归要求等待弹窗消失且不重复提交。

运行 [43423186926](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43423186926)
完成真实 Chrome 协议确认，但自动配对尚未连接。新增固定阶段与状态码诊断，区分原生转发、票据兑换和 WSS；
不输出 URI、查询参数、请求头或私有日志，仍保留原 TLS 和连接断言。

运行 [43426136991](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43426136991)
显示 begin 200、finish 409，未出现设备票据兑换，原生阶段为空。单独用完整 8.3 可执行路径复现了日志缺失；
短路径回归修复前失败，改用完整长路径确定日志目录和文件名，继续定位实际唤起失败。

运行 [43427569643](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43427569643)
仍无原生阶段和票据兑换。协议确认改为命中校验后的真实鼠标点击，并增加弹窗消失和 handler 执行证据断言。
修正升级诊断只观察 MCP 路径，避免把 Web 自身的 WebSocket 误记为设备通道；回归覆盖不同升级路径与查询参数脱敏。

运行 [43429347293](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43429347293)
在真实指针确认阶段失败，尚未执行 handler。保留重试最后一次原生控件错误，避免通用 deadline 掩盖拒绝原因。

运行 [43430317648](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43430317648)
明确报出 Native control is occluded。确认动作现按唯一按钮所属根窗口聚焦并等待前台稳定；
预检核对输入桌面与进程桌面，命中诊断限定 PID、控件类型和 class，不记录 Name、Title 或 URL。
