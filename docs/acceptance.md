# 验收记录与待完成事项

## 当前迁移边界

2026-11-16 起按 [Tauri 迁移确认](migrations/tauri-2026-11-16.md) 验证新桌面实现。
下方 Electron 的历史 CI、缓存、断点与浏览器证据保留为历史事实，不能替代 Tauri 的原生/GUI 验收。
新入口为 `build:shared`、各平台 `build:*`、`verify`、`test:product --target`、`test:installer --target`。
本轮已在本机生成 Windows x86/x64 安装包并通过两种架构各五项产物用例；macOS/Linux 与 Tauri 浏览器/托盘结果按本轮 CI 单独记录。

迁移基线日期：2026-11-07；最新浏览器自动化证据：2026-11-14（Asia/Shanghai）。适用独立项目 `0.1.0`、公共 DSH `0.1.6-alpha.2` 及所附兼容补丁。需求编号见[requirements](requirements.md)，设计见[design](design.md)，启动和配置见[configuration](configuration.md)。本文是证据清单，不把已实现或单元测试通过等同于完整产品验收。

## 已有证据

原生产物自动化入口的构建绑定、服务位和清理验证见[自动化记录](evidence/native-product-automation-2026-11-13.md)。

Chrome/Edge 与原生 GUI/托盘矩阵按[已批准设计](superpowers/specs/2026-11-13-browser-desktop-e2e-design.md)
使用 `pnpm test:browser` 单独执行；桌面预检失败、已有 URI handler 安全拒绝或场景跳过均不算通过。
提交 `ed2e500` 的 [完整 Windows CI](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43482404091)
已实际通过两种浏览器各七场景及网页伪确认/托盘遮挡拒绝检查，见[固定证据](evidence/browser-desktop-e2e-2026-11-13.md)。
报告区分配对、隐藏、托盘恢复、二次启动、重连、退出及回收；后续提交仍须核对各自 CI，
不关闭尚未覆盖的真实模型、跨用户、多设备和 A7 其他场景。

提交 `b96e3bc` 的[完整 CI](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43605821033)
另通过每浏览器 3 套全新 DSH 环境、9 次独立浏览器冷启动及全部清理，见[启动调查记录](evidence/startup-anomalies-2026-11-14.md)。
历史 Chrome 调试入口缺失和 Edge 插件激活异常未复现，根因仍未确认，不因冷启动矩阵通过而关闭。

2026-11-13 的 URI 短路径故障定位及修复回归见[原生 URI 修复记录](evidence/native-uri-short-path-2026-11-13.md)。
旧提交的本机通过记录不覆盖其远端 CI 失败；后续提交须以对应完整 CI 运行结果为准。

2026-11-13 的开发基础设施回归单独记录于[开发验证证据](evidence/development-validation-2026-11-13.json)。
该记录包含隔离源码目录的安装/检查与本机联调结果，不将本地暂存内容称为已发布提交，不关闭 A1—A5/A7。

下表记录迁移阶段实际执行结果，**不是本轮仅修改文档后重新运行的结果**。日志摘要、摘要来源哈希及当时产物哈希保存在[证据记录](evidence/migration-validation-2026-11-07.json)。产物会被后续构建覆盖，若哈希不同应重新验收，不把历史结果自动用于新二进制。该记录不含模型密钥、账户、cookie 或用户身份文件。

| 证据 | 结果 | 可以说明什么／不能说明什么 |
| --- | --- | --- |
| 独立仓库 `pnpm install --frozen-lockfile` | 成功 | 公共依赖安装；不是离线构建证明 |
| 独立仓库 `pnpm typecheck` | 退出 0 | 自有 TS 编译通过；不替代产品流程 |
| 独立仓库 `pnpm test` | 64 文件通过、2 文件跳过；541 测试通过、8 跳过 | 包含真实 stdio/HTTP/TLS fixtures 的自动测试；跳过项不算成功 |
| 两个显式 product 测试文件，开启产品开关并提供实际 Electron 输入 | 2 文件、5 测试通过 | 实际 profile 后台运行、文件 append/read、启动取消清理、调用目录环境优先级、原生 URI 转发接受/拒绝 |
| Windows 单 EXE 构建、服务端归档构建和公开导入烟测 | 成功，摘要见证据记录 | 已生成两端产物；不等于所有发布部署组合通过 |
| 普通 Windows 桌面 URI 激活及 Web 关联 | 服务 ready、状态 connected、下游 files 可用；GUI 显示运行中和已连接 | 已覆盖真实用户桌面注册/唤起及一个 DSH 连接，不只是注册表查询或 HTTP 模拟 |
| 用户此前人工确认 | GUI 自动连接/手动断开、托盘生命周期、退出无二次确认；模型创建并读回文件 | 属于迁移前的需求验证依据，不作为独立产物最新全流程回归通过证据 |

迁移文档基线当时只运行结构、链接、基线完整性和配置示例校验；后续实际运行的构建、原生产物和浏览器检查以上方固定 CI 证据为准。

## 逐项覆盖

### 初轮开源开发验证快照（2026-11-13）

本表保留当时未提交树的本机结果与边界，不代表当前 GitHub CI 状态；提交后的验证见上方最新证据。

| 目标 | 本轮结果 | 剩余边界 |
| --- | --- | --- |
| O1 / M1 / A6 源码独立性 | 独立源码目录重新安装依赖，未复制 node_modules/lib/用户 home；frozen 安装、build、typecheck、551 测试通过、8 跳过 | 允许复用公共 pnpm 内容缓存；未做冷缓存网络安装；验证时为未提交源码，后续交付状态以 Git 历史和远端引用为准 |
| O2 环境预检 | 基础/打包预检可执行，缺失项测试覆盖；明确 PowerShell、tar、csc、Node LICENSE 和临时打包盘符前提 | GitHub hosted CI 尚未由此未提交树触发 |
| O3 初始化 | 独立状态与证书实际生成；重复执行保留状态、非归属/链接拒绝和损坏证书测试通过 | 浏览器 CA 信任须开发者显式导入，初始化不修改系统信任 |
| O4 两端调试 | 真实 HTTPS 登录引导后 200、未登录 401；配对 begin/finish/status 200 且 connected；GUI 自有服务 ready；服务端及 Electron 均实际命中映射后的 TS 源码断点 | 未执行普通 Chrome/Edge 的 CA 导入和 URI 手工验收，不替代 A7 |
| O5 无密钥检查 | dev:check 58 项通过；前台 Web/runtime、开发 Electron 及退出清理已验证 | 未配置真实模型，不关闭 A1/A2/A4 |
| O6 CI 与产物 | Windows workflow 已配置；同一验证脚本在深路径隔离目录 exit 0，生成 EXE、插件包及 SHA256；NSIS 临时盘符已释放 | 本机执行不等于 GitHub Actions 已执行；没有发布 |
| O7 接手文档 | README/AGENTS、开发调试、贡献、安全报告、配置和模块入口已同步；A4 拆为六个后续子项 | B/M 的其余产品验收继续按下表保留 |

完整命令、源码文件指纹、脱敏结果及产物哈希见[开发验证证据](evidence/development-validation-2026-11-13.json)。
与本轮源码对应的验证会出现上游 `dsh-client-ui-primitives` 缺少 map 文件的非阻断警告；没有手改第三方包或屏蔽该警告。

### 产品需求

“自动覆盖”表示对应测试源码已随独立项目保留，并纳入上述通过的测试集合；不表示所有需求子场景都已验证。以下相对路径均在本仓库。

| 需求 | 实现及自动覆盖入口 | 产品验收状态 |
| --- | --- | --- |
| B1 Web 使用远端 agent | [browser/association.spec.ts](../packages/dsh-plugin/modules/browser/tests/association.spec.ts)、[agent.spec.ts](../packages/dsh-plugin/modules/agent/tests/agent.spec.ts) | 真实桌面已关联；迁移后真实模型全流程待补 A1 |
| B2 独立本地产品 | [local-profile.product.spec.ts](../packages/mcp-proxy/modules/runtime/tests/local-profile.product.spec.ts) | 单 EXE/profile 有证据；全新普通用户环境待补 A7 |
| B3 机器单实例 | [control.spec.ts](../packages/mcp-proxy/modules/runtime/tests/control.spec.ts)、[runtime.spec.ts](../packages/mcp-proxy/modules/runtime/tests/runtime.spec.ts) | 同用户测试有覆盖，跨登录用户/权限待补 A3 |
| B4 出站连接 | [dsh-connection.spec.ts](../packages/mcp-proxy/modules/runtime/tests/dsh-connection.spec.ts) | 真实 HTTPS/WSS 已连接；真实远端反向代理部署待补 A7 |
| B5 三种传输 | [local.spec.ts](../packages/mcp-proxy/modules/local/tests/local.spec.ts)、[tasks.spec.ts](../packages/mcp-proxy/modules/local/tests/tasks.spec.ts) | SDK fixture 集成覆盖；三种传输的模型/UI 联合矩阵待补 A1/A7 |
| B6 工具、结果与稳定别名 | [protocol.spec.ts](../packages/mcp-proxy/modules/protocol/tests/protocol.spec.ts)、[agent.spec.ts](../packages/dsh-plugin/modules/agent/tests/agent.spec.ts)、[tasks.spec.ts](../packages/mcp-proxy/modules/local/tests/tasks.spec.ts) | 完整富结果/模态产品回放待补 A1/A4；边界按需求能力表 |
| B7 模型直接调用 | [agent.spec.ts](../packages/dsh-plugin/modules/agent/tests/agent.spec.ts) | 自动模型 fixture 覆盖；最新产物真实模型调用待补 A1 |
| B8 URI 安装及关联 | [test-browser.ts](../scripts/test-browser.ts)、[native-activation.product.spec.ts](../packages/mcp-proxy/modules/runtime/tests/native-activation.product.spec.ts)、[native-windows.spec.ts](../packages/mcp-proxy/modules/runtime/tests/native-windows.spec.ts) | Chrome/Edge 的真实协议确认、handler 转发及 TLS 自动配对已验证；其他安装/部署边界见 A7 |
| B9 不依赖固定本地 TCP | [activation.spec.ts](../packages/mcp-proxy/modules/protocol/tests/activation.spec.ts)、[association.spec.ts](../packages/dsh-plugin/modules/browser/tests/association.spec.ts) | 已验证实际关联；错误目标/过期等主要为自动测试 |
| B10 每轮固定发起设备 | [agent.spec.ts](../packages/dsh-plugin/modules/agent/tests/agent.spec.ts)、[prompt.spec.ts](../packages/dsh-plugin/modules/browser/tests/prompt.spec.ts) | 两台真实电脑验收待补 A2 |
| B11 后续轮次换设备 | [agent.spec.ts](../packages/dsh-plugin/modules/agent/tests/agent.spec.ts) | 后续设备与当前轮次引导有自动覆盖，真实两设备待补 A2 |
| B12 工作目录与路径 | [settings.spec.ts](../packages/mcp-proxy/modules/local/tests/settings.spec.ts)、[local.spec.ts](../packages/mcp-proxy/modules/local/tests/local.spec.ts) | product 文件测试覆盖；不宣称目录权限沙箱 |
| B13 文件一致性假设 | [requirements](requirements.md#原有已确认行为) | 明确非同步功能，无同步验收要求 |
| B14 本地交付/远端临时 | [agent.spec.ts](../packages/dsh-plugin/modules/agent/tests/agent.spec.ts)、[local-profile.product.spec.ts](../packages/mcp-proxy/modules/runtime/tests/local-profile.product.spec.ts) | 本地文件 product 覆盖；真实模型两类路径待补 A1 |
| B15 断线不重放 | [runtime.spec.ts](../packages/mcp-proxy/modules/runtime/tests/runtime.spec.ts)、[invocations.spec.ts](../packages/mcp-proxy/modules/protocol/tests/invocations.spec.ts) | 故障 fixture 自动覆盖；实际桌面中断副作用核验待补 A2 |
| B16 页面关闭不终止 | [elicitation.client.spec.ts](../packages/dsh-plugin/modules/ui/tests/elicitation.client.spec.ts)、[agent.spec.ts](../packages/dsh-plugin/modules/agent/tests/agent.spec.ts) | 页面/服务生命周期有自动覆盖，真实浏览器关页重开待补 A1 |
| B17 Windows Chrome/Edge | [test-browser.ts](../scripts/test-browser.ts) 与[双浏览器证据](evidence/browser-desktop-e2e-2026-11-13.json) | 当前七场景均已验证；不表示浏览器 × 传输 × 故障矩阵完成，见 A7；macOS/Linux 暂缓 |
| B18 sampling | [agent.spec.ts](../packages/dsh-plugin/modules/agent/tests/agent.spec.ts)、[runtime.spec.ts](../packages/mcp-proxy/modules/runtime/tests/runtime.spec.ts) | 文本及取消/失败路径有自动覆盖；图片模态和实际模型请求待补 A1 |
| B19 elicitation | [elicitation.spec.ts](../packages/dsh-plugin/modules/host/tests/elicitation.spec.ts)、[elicitation.client.spec.ts](../packages/dsh-plugin/modules/ui/tests/elicitation.client.spec.ts) | live 表单/URL 与单次回答有覆盖，历史归约及重启终态待补 A4 |
| B20 roots | [local.spec.ts](../packages/mcp-proxy/modules/local/tests/local.spec.ts) | 配置/初始化自动覆盖；不承诺动态 roots 通知 |
| B21 完整插件启用/释放 | [server.spec.ts](../packages/dsh-plugin/tests/server.spec.ts) | Loader 挂载/卸载及激活失败回滚覆盖；真实安装后禁用/卸载待补 A5 |
| B22 / M4 桌面分发 | [runtime-inventory.spec.ts](../scripts/runtime-inventory.spec.ts)、[product-build.spec.ts](../scripts/product-build.spec.ts)、[test-installer.ts](../scripts/test-installer.ts) | 原单文件技术限定已由 M4 改为安装包；新程序/运行时/安装包绑定分别验证，旧缓存测试不再适用 |
| B23 GUI/托盘/直接退出 | [test-browser.ts](../scripts/test-browser.ts)、[Rust 桌面测试](../packages/mcp-proxy/src-tauri/src/main.rs)、[service-shutdown.spec.ts](../packages/mcp-proxy/tests/service-shutdown.spec.ts) | 业务要求保留；Tauri 实测结果单独记录，不套用 Electron 历史绿灯 |
| B24 多 DSH 独立连接 | [managed-runtime.spec.ts](../packages/mcp-proxy/modules/runtime/tests/managed-runtime.spec.ts) | 自动覆盖，两真实独立部署与 EXE 联合待补 A2 |
| B25 共享 MCP 增删 | [management.spec.ts](../packages/mcp-proxy/modules/local/tests/management.spec.ts) | 增删、失败不提交、实例替换自动覆盖；GUI 双部署联验待补 A2 |
| B26 取消及影响范围 | [routing.spec.ts](../packages/mcp-proxy/modules/local/tests/routing.spec.ts)、[management.spec.ts](../packages/mcp-proxy/modules/local/tests/management.spec.ts) | 路由/取消 fixture 覆盖；实际副作用和清理待补 A2 |
| B27 自动配对与断开意图 | [test-browser.ts](../scripts/test-browser.ts)、[desktop-controller.spec.ts](../packages/mcp-proxy/modules/runtime/tests/desktop-controller.spec.ts)、[pairing.spec.ts](../packages/dsh-plugin/modules/host/tests/pairing.spec.ts) | Chrome/Edge 实际自动配对、GUI 断开及新 URI 重新配对已验证；重启/迟到响应故障主要为自动测试 |
| B28 来源全程固定 | [multiple-dsh.spec.ts](../packages/mcp-proxy/modules/local/tests/multiple-dsh.spec.ts)、[routing.spec.ts](../packages/mcp-proxy/modules/local/tests/routing.spec.ts) | 重复 ID、回调和乱序自动覆盖；两真实 DSH 待补 A2 |
| M1 独立项目 | 公共依赖、内部模块打包及产物导入验证 | 干净 checkout 的公共安装、两端构建及完整 Windows CI 已验证；发行范围见 A6 |
| M2 两条构建命令 | `scripts/build.ts`、EXE/归档构建记录 | 当前 CI 已生成并绑定两端产物，未发布到 npm/GitHub |
| M3 固定版本最小补丁 | [compatibility.spec.ts](../scripts/compatibility.spec.ts)、安装器实际版本检查 | 白名单修复已验证；完整持久化/SDK 回归见 A4 |

## 独立复现流程

### 自动检查

在本项目根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build:shared
pnpm typecheck
pnpm test
pnpm build:mcp-proxy
pnpm build:mcp-plugin
```

记录 Node/pnpm/Windows 版本、代码提交（有提交后）、产物 SHA256、实际命令、退出状态和跳过项。不要把声明的命令或先前通过日志当成这次执行。默认 `pnpm test` 不运行需要独占机器服务位的 product 用例。

product 测试要求空闲服务位，不能与用户运行的连通服务并行，不停止未知进程。
入口按 `--target` 读取 `release/mcp-proxy/<目标>/product-build.json`，校验同次安装包、应用程序和完整运行时。
Windows 要求五项、Mac/Linux 要求三项实际用例零跳过；安装器验证另用 `test:installer`。

```sh
pnpm build:win
pnpm test:product --target win-32
pnpm test:product --target win-64
pnpm test:installer --target win-64
```

入口不按目录时间或“最新名字”猜测。需保留该次 `.artifacts/build-<目标>-*/distribution/` 及安装包原件。
记录缺失、目标不符或产物被替换时重建；验收不修复运行时。验证前后检查服务位与创建身份，成功才删除自有测试数据。
失败现场不上传。每目标结果保存到 `.artifacts/ci/product-<目标>.json`、`installer-<目标>.json`，浏览器另有按目标汇总。

release CI 在两端打包后自动调用该入口，并保留 `.artifacts/ci` 的报告；默认 `pnpm test` 的 5 项产品跳过由此单独执行，3 项 POSIX 跳过仍按 Windows 平台规则保留。native product 用例只证明原生 helper 的转发，不证明 Chrome/Edge 实际触发了 URI，也不替代真实模型、多设备或跨用户验收。

### 两产物、普通浏览器和模型

1. 按[配置指南](configuration.md)在独立 DSH 安装上安装完整插件目录、应用固定兼容补丁，配置既有登录/模型和公开 HTTPS，启动 `dsh --profile web`。不要修改模型来适配代理。
2. 在普通 Windows 用户桌面运行本次 EXE，确认空配置可启动、URI 注册无错误，添加一个有明确文件工具和受控工作目录的下游 MCP。应用本身没有文件工具。
3. 在普通 Chrome/Edge 登录 DSH，尚未建会话时点击“连接这台电脑”。确认自动配对、DSH 和 GUI 均显示已连接，不能只以浏览器弹窗或注册表存在为依据。
4. 新建会话，请模型创建一个唯一新文件、写入测试文字，再通过下游 read 工具读回；人工/独立程序检查本地文件内容和工具事件，不能仅相信模型文字。要求远端临时处理时确认没有拿服务器文件替代本地交付。
5. 请求 sampling 和表单/URL elicitation 工具，验证模型配置、表单答案、拒绝/取消及父调用归属。待回答时关闭页面后重开，原调用仍存活才允许回答；重启后不得重发原工具。
6. 两台电脑使用同服务别名和工具名，向同会话提交前后两轮；第二台打开/引导不改第一轮去向。跨设备预先准备一致工作文件，本项目不负责同步。
7. 同一 EXE 连接两个真正独立的 DSH，分别调用共享服务；断开一个、删除一个 MCP、重用别名，再检查路由、取消、另一服务、历史轮次和实际副作用。
8. 执行中中断网络/退出应用，核对失败或未知、不重放；再验收托盘、第二次启动、停止、禁用/卸载插件和所属 URI 清理。保留工作文件与历史。

开发 fixture 可使用 [files.mjs](../packages/mcp-proxy/modules/local/tests/fixtures/files.mjs)，它提供 append、read、pid、sample、ask、append-wait、has-env；它是测试依赖，不打包成默认文件功能，没有目录沙箱。它需要本仓库开发依赖及 Node；普通用户可换成已有的文件 MCP，不要求安装本仓库。

## 待完成事项

下列优先级是继续开发的建议顺序，不是新增已批准产品范围。验证发现实现缺陷时先记录对应 B/M 编号，再修复和复验。

| 编号 | 类别 | 下一步及完成条件 |
| --- | --- | --- |
| A1 | 联合验收缺口 | 使用迁移后的两个产物和真实模型完成文件读写、富结果、sampling、elicitation、关页重开；覆盖三种传输并保存脱敏记录。以前人工成功不替代最新产物回归 |
| A2 | 多设备/多部署验收缺口 | 两电脑同名工具、两真实 DSH、重复 ID/乱序/取消、目录实例更换；独立文件副作用或带所有权标记的下游日志证明不串线、不重放 |
| A3 | Windows 安全/单实例验收缺口 | 不同普通登录用户、profile 和工作目录并发启动，验证机器排他和 IPC 权限；第二用户不能借用第一用户的控制能力；必要时修复安装/权限实现 |
| A4 | 持久化及历史实现/验证缺口 | 按[A4.1—A4.6 工作契约](history-recovery-work.md)校验重启、会话重开、fork、未知结果、sampling/elicitation 历史。当前没有专用历史待回答归约器；补齐不可继续的终态展示，不恢复丢失的 live 续接。核验 TS/Python SDK 完整读写及无密钥快照，不能仅依赖事件白名单 |
| A5 | 安装生命周期验收缺口 | 全新公共 DSH 安装、升级已存在配置、冲突补丁、插件禁用/卸载/重启；核对路由、工具、UI、监听和连接清理，保留必需历史读取能力 |
| A6 | 发行交付剩余项 | 干净 checkout 公共安装、Windows 构建、原生产物及浏览器 CI 和固定证据已有验证；仍未执行正式签名/发布流程及发布后安装验收。当前未发布 npm 包或 GitHub release，须按用户授权另行处理 |
| A7 | 桌面/部署矩阵剩余项 | 当前同构建 Chrome/Edge 七场景及回收已有固定 CI 证据；仍需新 Windows 用户/权限、目录/磁盘/缓存异常、URI 冲突、浏览器 × 传输 × 故障、真实远端 TLS 反代及模型流程演示。不得用本轮子矩阵关闭整项 |

设备撤销 GUI、CA 导入向导、MCP 编辑、自动更新、macOS/Linux、resources/prompts 或通用通知代理属于可另行决定的扩展，不混入 B1—B28 的完成条件。已有架构代码不等于这些扩展已经交付。

继续开发时先选择 A 项并引用对应 B/M 编号，运行相关测试，更新此记录的产物哈希、结果和剩余项。没有产品证据的场景始终保留待验收，不以增加通过测试数量关闭它。
