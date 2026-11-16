# 配置、安装与运行

本文从本仓库的两个发布产物出发，不要求消费项目源码。配置字段对应当前 `0.1.0` 实现；支持的 DSH 固定为 `0.1.6-alpha.2`、Cordis 为 `4.0.2`。升级这些依赖前须完成兼容与会话恢复验证。

## 开发与打包

新设备从零准备工具链与隔离调试环境见[开发指南](development.md)。本页主要说明发布配置和维护操作。

使用 Node 22.19+、pnpm >=10、Rust 和宿主原生 Tauri 工具链。所有应用携带同一版本 Node 22.23.5；
用户不需要另装客户端运行时，但下游 MCP 自己需要的 Node、Python 等仍由用户提供。

```sh
pnpm install
pnpm build:shared
pnpm typecheck
pnpm test
pnpm build:win
pnpm build:mcp-plugin
```

| 输出 | 用途 |
| --- | --- |
| `release/mcp-proxy/win-32/`、`win-64/` | 对应架构 NSIS 安装包；安装后运行 mcp-proxy.exe |
| `release/mcp-proxy/mac-intel/`、`mac-arm/` | 对应架构 DMG |
| `release/mcp-proxy/linux/` | Ubuntu x64 deb |
| `release/mcp-proxy/j-show-mcp-proxy-runtime-0.1.0.tgz` | 额外的 Node profile 归档，仅供产物集成测试，不是用户安装步骤 |
| `release/mcp-plugin/j-show-dsh-plugin-mcp-proxy-0.1.0.tgz` | 含内部模块和浏览器产物的服务端插件 |
| `release/mcp-plugin/install.mjs`、`release.json`、补丁、许可证 | 服务端发布安装工具及配套文件，需保留整个目录 |

在对应宿主调用 `build:win:32`／`build:win:64`／`build:win`、`build:mac:intel`／`build:mac:arm`／`build:mac`、`build:linux`。
没有顶层 `build`，共享产物按指纹及输出清单复用一次；`build:mcp-proxy` 是当前宿主兼容入口。
`--connection-presets <file>` 保留公开 origin/CA 预设；不再使用 Electron 分发目录或 Node 模式选项。
中间文件在 `.artifacts/`，不提交运行时、profile 或密钥。Windows 安装器可补装缺失的 WebView2。

## 本地应用

安装后打开应用即创建缺失的空配置、启动服务并注册 `mcp-proxy://`，不要求用户执行注册表、证书或安装脚本。空服务器列表和空 MCP 列表是正常初始状态。通过 GUI 添加 MCP，再到已登录的 DSH Web“设置 → 本机连接”点击“连接这台电脑”；应用内不再要求允许，浏览器/操作系统自身提示仍可能出现。

连接以各 DSH 地址分别展示。GUI 可断开其中一个；该地址持久禁用，直到它的 Web 再次发起新激活。关闭窗口只隐藏到托盘；单击托盘显示 GUI，右键列出状态并可直接退出。退出停止自有服务和 MCP 子进程，不删除用户文件或停止外部 HTTP 服务。

| 默认位置 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%/McpProxy/data/settings.json` | 版本化本地配置 |
| `%LOCALAPPDATA%/McpProxy/data/identity.yaml` | 受凭据提供方管理的私钥材料，不应展示或提交 |
| `%LOCALAPPDATA%/McpProxy/data/dsh/` | 固定本地 profile、URI 安装记录及所属辅助文件 |
| 安装目录中的 `resources/` | 内置 Node、依赖和不可变清单，不存放用户配置，也不在验收时修复 |
| `%LOCALAPPDATA%/McpProxy/bootstrap/desktop.log` | 桌面/监督进程阶段诊断，不记录激活票据 |
| 系统解析的 Documents 下 `mcp-proxy-workspace` | 新配置的默认工作目录；可能随系统文档目录重定向而变化 |

`--config <file>` 可选择已有配置，`DSH_HOME` 可覆盖 profile home。显式配置中的目录和身份路径保留，应用不会把旧配置自动搬到新路径。修改 JSON 前先退出应用并备份；当前 GUI 支持 MCP 增删，没有服务编辑、服务器手工输入或全局工作目录编辑表单。外部修改不承诺自动热加载，重启后生效。

macOS 数据基目录为 `~/Library/Application Support/McpProxy`，Linux 为 `${XDG_DATA_HOME:-~/.local/share}/mcp-proxy`；
两者的配置/身份位于 `data/`，诊断位于 `bootstrap/desktop.log`。

### 本地 JSON 示例

以下为可解析的 v2 字段示例，不包含可运行的真实 MCP；替换命令、文件路径和地址后再使用。服务器列表保持空，由 Web 配对后自动写入。工作目录应事先准备，身份文件由运行时管理，不填写私钥到 JSON。

```json
{
  "version": 2,
  "directory": "C:/McpProxy/workspace",
  "identityFile": "./identity.yaml",
  "services": [
    {
      "service": "files",
      "transport": "stdio",
      "command": "C:/Tools/node.exe",
      "args": ["C:/Tools/my-mcp/server.mjs"],
      "cwd": ".",
      "roots": ["."],
      "env": {}
    },
    {
      "service": "http_tools",
      "transport": "streamable-http",
      "url": "http://127.0.0.1:9000/mcp",
      "headers": {}
    },
    {
      "service": "legacy_tools",
      "transport": "sse",
      "url": "http://127.0.0.1:9001/sse",
      "headers": {}
    }
  ],
  "servers": []
}
```

| 字段 | 规则 |
| --- | --- |
| version | 当前为 `2`，顶层拒绝未知字段 |
| directory、identityFile | 必填；相对路径相对于 settings.json 所在目录解析 |
| services | 共享于全部 DSH；`service` 唯一，匹配 `[A-Za-z0-9_-]{1,32}` |
| transport | `stdio`、`streamable-http` 或 `sse` |
| command、args、env | stdio 专用；command 非空；args 是字符串数组，不是 shell 命令行；env 为字符串字典 |
| url、headers | HTTP/SSE 专用；仅 http/https，不接受 URL 用户名密码；headers 为字符串字典 |
| cwd、roots | 相对于顶层 directory；省略 cwd 使用 directory，省略 roots 使用 cwd，显式 `[]` 返回空 roots；均不构成访问沙箱 |
| servers | 默认自动管理，不复制其他电脑的身份引用；同 origin 或同 id 重复会拒绝配置 |

每个自动登记 server 包含 `id`、规范 `origin`、`enabled`、`mode:"device"`、`identityRef`，可有本地 `caFile` 和 `upgradePath`。origin 必须是没有路径及尾随 `/` 的规范 HTTPS origin；密钥存于 identityFile，JSON 只保存引用。legacy 条目还要求 `credentialRef`，只供旧配置迁移使用。不要手工构造配对密钥来替代 Web 激活。

GUI 参数按行填写；环境变量/请求头输入 JSON 对象，roots 按行填写目录。GUI 保存后的列表不回显秘密，但 stdio env 和 HTTP headers 在本地配置中仍是明文，需按用户敏感文件保护。DSH 凭据引用从隐式继承环境中排除；显式下游 env 是用户授权配置，不应填写 DSH 私钥或部署秘密。

### 管理命令与移除

普通用户使用 GUI。下列命令是维护入口，路径应替换为实际已生成的配置，且使用相同 `DSH_HOME`（如设置过）：

```powershell
.\mcp-proxy.exe --config "C:\McpProxy\settings.json" --stop
.\mcp-proxy.exe --config "C:\McpProxy\settings.json" --install
.\mcp-proxy.exe --config "C:\McpProxy\settings.json" --uninstall
```

`--install/--uninstall` 操作该 profile 拥有的 URI 入口；不覆盖或删除无关所有者。`--uninstall` 不是删除所有用户数据或撤销所有服务器设备。移除前退出 GUI，再移除所属 URI；确认无运行进程后才可删除自己的 EXE/缓存。配置、身份和工作文件是否保留由用户决定，不要把删除整个数据目录作为故障修复步骤。已有自动登记设备的撤销管理尚无完整产品 UI。

## 服务端安装和启动

DSH 本身须已安装且能通过既有账户系统正常运行，具备 Web、LLM、凭据、Session、工具、附件等所需服务。插件不选择模型，也不包含部署密钥。停止目标 DSH，备份其包管理配置和 profile 配置后，在持有完整服务端 release 目录的位置运行：

```sh
node release/mcp-plugin/install.mjs --dsh-root <目标DSH包管理安装根目录>
```

`--dsh-root` 需要存在 package.json 并能解析实际 DSH CLI，**不是** `$DSH_HOME/profiles/web`。`--profile <name>` 默认 web；源码式 DSH 安装可用 `--dsh-cli <相对根目录的CLI入口>`。自定义 profile home 使用 DSH 的 `DSH_HOME`。安装依赖需要 Node、pnpm、网络及目标安装写权限。

安装器先验证实际 CLI/session 固定版本，再探测已知事件。缺四个事件名时，在**指定目标 DSH 安装根目录**写入最小 pnpm patch、备份工作区配置并重新安装依赖；已有 session patch 时失败并要求显式合并，不覆盖。然后执行公开 `dsh plugin --profile web add <归档>`。本仓库开发依赖的补丁只影响本仓库，不能替代目标安装验证。

启动环境设置 `MCP_PROXY_ORIGIN` 为外部可访问的规范 HTTPS origin，再用目标安装的 `dsh --profile web` 启动。DSH 原有登录、模型、端口、TLS 终止及其他启动配置由部署者已有配置提供，本指南不改为另一模型或另造启动服务。

```powershell
$env:MCP_PROXY_ORIGIN = 'https://agent.example.com'
dsh --profile web
```

示例域名需要替换并部署有效证书。反向代理需要转发 HTTPS API 和 WebSocket Upgrade，保留 Host、Origin 及鉴权所需头/cookie。默认通道 `/mcp-proxy/connect`；配对接口 `POST /mcp-proxy/pair` 及 Web `/api/mcp-proxy/*` 需可达。UI 入口可与内部 TLS 通道不同，但公开 origin、证书、反向代理和设备证明必须一致，不能照搬测试端口。

### 服务端覆盖配置

发布 bundle 的[默认 patch](../packages/dsh-plugin/cordis.patch.yml)插入 `mcp-proxy-server`，默认 device 准入，设备登记文件在目标 profile 下。父插件配置字段为 host、agent、browser、ui。以下是目标 profile 的 Cordis 覆盖示例，保持同一 id 修改已插入条目，不重复 insert：

```yaml
- id: mcp-proxy-server
  config:
    host:
      publicOrigin: https://agent.example.com
      admission: device
      deviceRegistryFile: /var/lib/dsh/mcp-proxy-devices.json
      callTimeoutMs: 60000
      elicitationLifetimeMs: 600000
    agent:
      maxInstructionBytes: 32768
      maxSamplingTokens: 4096
    browser:
      maxRequestBytes: 4096
      browserLifetimeMs: 86400000
    ui:
      pollIntervalMs: 500
      statusIntervalMs: 15000
```

登记文件需位于服务进程可写的持久目录。Windows 使用对应绝对路径。不要在多台独立 DSH 之间共享设备登记文件或会话状态来替代各自来源认证。legacy/both 模式还需配置 `credentialRef` 及既有凭据提供方，不用于默认自动配对流程。

### 预算与默认值

以下来自当前 Config；大小单位为字节、时间为毫秒。正整数预算须满足源码 schema 上限及跨字段校验，不能通过调高预算规避无效协议。人工等待同时受父调用、下游及回调的较短截止时间约束；只调高 elicitationLifetimeMs 不会让 60 秒工具调用无限等待。

| host 字段 | 默认值 |
| --- | --- |
| publicOrigin、deviceRegistryFile | 前者必填；device 模式需要后者 |
| admission、credentialRef | 直接 schema 默认 legacy；发布 patch 明确 device；legacy/both 需要 credentialRef |
| maxDevices、maxDeviceRegistryBytes、deviceRegistryLockTimeoutMs | 4096、4194304、5000 |
| maxPairingRequests、maxPairingRequestBytes、pairingRequestTimeoutMs | 16、8192、10000 |
| upgradePath、maxConnections | `/mcp-proxy/connect`、64 |
| maxFrameBytes、handshakeTimeoutMs、callTimeoutMs | 1048576、10000、60000 |
| maxInvocations、maxPending、maxCatalogRevisions、maxCatalogHistory | 4096、32、64、4096 |
| associationCapacity、associationChallengeLifetimeMs、associationGrantLifetimeMs | 4096、30000、600000 |
| heartbeatIntervalMs、heartbeatTimeoutMs | 15000、10000 |
| maxPendingElicitations、elicitationLifetimeMs、maxElicitationBytes | 64、600000、32768 |

| 组 | 字段及默认值 |
| --- | --- |
| agent | maxInstructionBytes=32768，maxSamplingTokens=4096 |
| browser | maxRequestBytes=4096，maxCookieBytes=8192，maxCookieEntries=64，browserLifetimeMs=86400000，maxPromptBytes=314572800，maxPromptRequests=32 |
| ui | pollIntervalMs=500，statusIntervalMs=15000，associationTimeoutMs=30000，requestTimeoutMs=10000，maxResponseBytes=65536 |
| 本地 runtime：调用/恢复 | startupTimeoutMs=10000，callTimeoutMs=60000，reconnectDelayMs=1000，heartbeatIntervalMs=15000，heartbeatTimeoutMs=10000，taskCancelTimeoutMs=5000 |
| 本地 runtime：容量 | maxFrameBytes=1048576，maxInvocations=4096，maxPending=32，maxServices=32，maxDiscoveryPages=64，maxClientRequests=32，maxClientRequestRecords=4096，maxServers=64 |
| 本地 runtime：目录/激活 | maxCatalogRevisions=64，maxCatalogHistory=4096，maxActivations=4096，activationLifetimeMs=60000，desktopConnectTimeoutMs=30000，desktopConnectPollMs=100 |
| 本地 runtime：控制/管理 | controlTimeoutMs=5000，maxControlConnections=16，managementTimeoutMs=60000，maxManagementRequestBytes=1048576，maxManagementResponseBytes=1048576 |
| 本地 runtime：配对/退出 | pairingTimeoutMs=10000，maxPairingResponseBytes=8192，processJobDrainTimeoutMs=1000，processJobPollMs=10 |
| 本地 startup | controlTimeoutMs=5000，serviceStartTimeoutMs=30000，serviceStartPollMs=100，serviceStopTimeoutMs=2000，maxManagementResponseBytes=1048576 |

本地 runtime 的预算不是 settings.json 字段。维护者在本地 `mcp-proxy` profile 的 Cordis 覆盖中按 id `mcp-proxy-runtime`/`mcp-proxy-startup` 修改；不要把这些字段混入严格 v2 JSON。完整来源为 [runtime Config](../packages/mcp-proxy/modules/runtime/src/index.ts)、[startup Config](../packages/mcp-proxy/modules/runtime/src/startup.ts)及各服务端模块的 Config。

### 禁用与卸载插件

停止 DSH 后，在目标 profile 的 `cordis.patch.yml` 添加 `- id: mcp-proxy-server`、`disabled: true` 的同一条覆盖（YAML 两字段同级），重启验证本地连接入口、路由及工具消失。重新启用时移除此禁用覆盖。不要单独卸载某个内部模块。

彻底移除时先备份并清理自己添加的该条配置，再运行 `dsh plugin --profile web remove @j-show/dsh-plugin-mcp-proxy`。保留原 Session 和设备历史，不自动回退四事件补丁：含插件必需事件的旧会话仍需要兼容读者。需要回退目标安装的包管理补丁时，先确认不会读取这些会话并人工合并其他配置，不可自动恢复整份旧工作区备份。禁用/卸载后的真实产品回归见[待验收事项](acceptance.md#待完成事项)。

## TLS 与故障定位

默认使用系统受信任 HTTPS。私有 CA 部署可使用经过校验的部署专用构建预设 `--connection-presets <json>`，格式为 `[{"origin":"https://agent.example.com","certificate":"PEM公开CA证书"}]`；实际 certificate 必须是完整有效的 PEM 公开证书，不打包私钥。预设在激活前保持禁用。没有预设时，首次自签名部署不能假定普通 EXE 会自动信任；当前没有通用 GUI 导入 CA 向导。不要关闭 TLS 校验或通过激活 URI 注入信任材料。

| 现象 | 检查方向 |
| --- | --- |
| 本机服务启动失败 | 应用状态诊断、已有机器服务所有者、无效旧配置、下游命令及依赖、磁盘空间；保留原配置，不删身份重配 |
| 协议未注册 | 应用是否实际运行、GUI URI 注册错误/重试、无关协议所有者冲突；不能只根据是否有浏览器弹窗判断 |
| 连接未完成 | 登录 cookie、票据是否过期、目标 HTTPS 可达、证书信任、WSS Upgrade、服务端插件是否完整启用 |
| 已连接但工具不可用 | MCP 是否可用、目录是否已确认、当前轮次是否固定旧实例；新建下一轮，不把旧调用迁到新实例 |
| 写入或读取异常 | 先看实际下游工具名、参数、cwd/roots 和权限；代理没有自带文件工具，不改写路径 |
| sampling/人工回答失败 | 会话模型、支持模态、表单字段范围、父调用是否仍存活、各层截止时间；不要重新提交有副作用工具来恢复旧续接 |

报告问题只提供脱敏阶段、版本、时间及错误码，不贴激活票据、cookie、身份文件、真实请求头或模型 API key。
