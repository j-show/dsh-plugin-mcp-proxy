# Windows 浏览器与桌面验收

记录日期：2026-11-14（Asia/Shanghai）。基线为 `33379e82589596fa37af53c93983115848a1f84f`，范围按[已批准设计](../superpowers/specs/2026-11-13-browser-desktop-e2e-design.md)执行。

## 已验证结果

实现提交：`ed2e5009f56e672d9f6bd58602200d8d7d09a3d0`。完整 [Windows CI 43482404091](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43482404091) 成功，checkout 为 clean，十条 release 验证命令均退出 0。
[机器可读证据](browser-desktop-e2e-2026-11-13.json)保留提交、运行、环境、浏览器版本、构建摘要及全部场景标志；不引用本机聊天记录或私有配置作为验收前提。

| 检查 | 结果 |
| --- | --- |
| 默认测试 | 573 通过、8 跳过；5 项 product 由独立入口执行，3 项 POSIX 按 Windows 平台跳过 |
| 开发检查 | 58 通过；类型检查、两端打包成功 |
| 原生产物 | 5 项实际通过、零跳过；服务位前后 idle，测试数据已删除 |
| Chrome | 156.0.8078.80；七场景全部通过 |
| Edge | 156.0.4314.58；七场景全部通过 |
| 网页伪确认拒绝 | 两浏览器均实际测得 Document 深度 51，超过原生祖先上限 32，定位器拒绝 |
| 托盘遮挡拒绝 | 两浏览器均以本轮顶层窗口遮挡目标，验证拒绝后销毁，再执行真实鼠标点击 |
| 回收 | 两浏览器的窗口、后台及 MCP 进程退出；URI、临时 CA、服务位检查通过，私有状态已删除 |

七场景为：真实 URI 唤起与 HTTPS/WSS 自动配对、关闭隐藏、托盘恢复、二次启动无重复实例、GUI 断开与重新配对、原生托盘菜单退出、资源回收。
实际点击/输入进入原生 UI；不以注册表存在、单元测试数量或管理 API 的成功代替浏览器/托盘动作。

两个浏览器均绑定同一构建 `build-proxy-OmG3G9`：

- 客户端 EXE SHA256：`e46d7eaf40bfe5a907e69d1b3b7678007e8b94247439763851389b9e336de3df`
- runtime 清单 SHA256：`5c5dbcff858ed5fbfb89e36ba394f9f33e0c88531fcfb6a039bb9d70079b0b43`
- 服务端插件 SHA256：`2bc993b729a089aca712891f8f37fd51cafb40cc71f652be91c254c3862f8ac4`

产物被后续构建覆盖后须重新验证，不能将此摘要用于另一份二进制。该记录不表示已发布 npm 包或 GitHub release。

## 复现入口

在具备活动输入桌面、Explorer 和 Chrome/Edge 的 Windows x64 环境中执行：

```powershell
pnpm install --frozen-lockfile
pnpm test:browser --preflight
./scripts/verify.ps1 -Mode release
```

服务位及用户/系统合并 URI 注册必须空闲。已有安装会安全拒绝；使用独立测试机器、虚拟机或测试用户前仍须核对机器服务位。
单独执行浏览器矩阵前先完成 `pnpm build:mcp-proxy` 与 `pnpm build:mcp-plugin`。入口使用构建记录，不按目录时间选择产物。

详细操作及维护约束见[开发指南](../development.md#真实浏览器和桌面验收)。失败 profile、CA 私钥和原始服务日志保留在本轮私有目录，不上传；CI 只保留经过检查的报告和界面区域。

## 已定位并覆盖的回归

| 问题 | 修复与证据 |
| --- | --- |
| URI 由 Explorer 启动丢失 app-data 上下文 | trusted receipt 保存 LOCALAPPDATA；3 种原生启动回归修复前失败、修复后通过 |
| 完整 8.3 路径缺失诊断 | 用规范长路径定位日志；真实短路径启动回归保留，日志无 URI |
| 进程加载期间 MainModule 不可用 | 只读有限权限句柄查询映像；真实挂起进程回归验证模块未就绪、映像正确及子进程终止 |
| SDK 协商会退出初始 MCP 子进程 | 区分已退出标记与当前创建身份子树；拒绝存活的未知标记，二次启动比较实际实例 |
| 新 DSH 引导遮挡设置 | 实际点击非约束性 Continue 与可选 Configure later；点击前核对命中 |
| Chromium 协议提示保护期 | 等待焦点/前台/边界稳定及系统保护间隔后只输入一次；不抑制提示或保护 |
| Edge Open 标签与句末标点 | 最小原生上下文核对品牌、来源、唯一 Cancel，拒绝 Document；原生文本回归覆盖标点与名称伪装 |
| UIA FromPoint 返回逻辑祖先 | 通知图标组合物理 HWND 命中、限定祖先与交叠控件检查；真实遮挡负回归保留 |
| 模态按钮在两个窗口路径重复枚举 | Automation.Compare 去重同一元素，两个不同同名控件仍拒绝；GUI 断开与重新配对实际通过 |
| 原生托盘菜单不在桌面直接子层 | 右键一次后读取 GUI 自有可见窗口中的唯一 Exit；等待菜单而不重发鼠标动作 |
| 不确定输入在回收中被重放 | session 禁止后续托盘 UI 回收，转入归属校验的服务/进程回收；成功/未知确认门、并发 tick 有回归 |
| 原生升级组合用例总预算不足 | 总预算 90 秒，PowerShell 各限 10 秒，安装/卸载各 5 秒及全部 owner/文件断言保留 |

本机另用不注册 URI 的私有开发入口做过定向定位：管理 API 仅建立 connected 前置状态，真实 GUI 确认后 disconnected，真实托盘 Exit 后进程/服务退出，原 URI 哈希不变。
这不是同构建浏览器验收；上面的 release CI 才是本轮双浏览器结论。

## 仍未覆盖与待观察

- 真实模型、多设备/并发独立 DSH、跨 Windows 用户/权限、完整传输与故障矩阵、远端反向代理部署以及发布流程仍按 A1—A7 分别验收。
- [43477202103](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43477202103) 曾出现一次 Edge UI 插件激活失败；本次完整运行未复现，尚未确认根因。已增加脱敏 exception/console/log、ui-config 状态、解析框架版本及同源模块 source hash，不能将诊断增加称为该问题已修复。
- 首次 [43436591764](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43436591764) 未建立 Chrome 调试入口，同提交第二次进入实际桌面场景。该单次启动异常未确认根因；不通过静默重试或场景跳过掩盖失败。
