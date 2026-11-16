# Intel Mac DMG：记录并暂缓

用户决定（2026-11-16）：保留 DMG，记录情况并跳过当前宿主，后续更换 Mac 再尝试。
这不是 Intel DMG 验收通过，也不移除 `build:mac:intel`／`build:mac` 的构建能力。

## 已观察结果

| 提交与 CI | 实际结果 |
| --- | --- |
| `41c788c`，[运行 43814561040](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43814561040) | Tauri Intel `.app` 编译通过；DMG 布局脚本等待临时磁盘卸载约 30 分钟后失败 |
| `7bd8040`，[运行 43820615268](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43820615268) | 保留 `.app`、直接调用 `hdiutil create`，五分钟超时 |
| `72d79bc`，[运行 43831542330](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43831542330) | `sudo -n` 与详细日志确认有效 UID 为 0，文件复制已完成，随后仍在镜像收尾超时 |

```mermaid
flowchart LR
  App[Tauri Intel app 编译通过] --> Copy[镜像内文件复制完成]
  Copy --> Finalize[镜像收尾超时]
  Finalize --> Deferred[按用户决定暂缓该宿主]
```

确认的边界是镜像收尾阻塞；没有确认权限或 Spotlight 是根因。
实验性提权没有解决问题，已移除该构建选项，不修改或停用系统服务。
没有由失败尝试生成可验收的 Intel DMG；不能用 `.app` 编译成功替代安装包和产品验证。

## 当前 CI 与复测

自动 CI 保留 Windows x86/x64、macOS ARM 和 Ubuntu，默认不调度 Intel lane。
摘要及 `.artifacts/ci/native-matrix.json` 明确记录 Intel 为 `skipped`／`not verified`。
Mac 仍采用 DMG 交付；在另一台具备工具链的 Mac 上执行：

```sh
pnpm install --frozen-lockfile
pnpm build:mac:intel
pnpm test:installer --target mac-intel
pnpm test:product --target mac-intel
```

需要 CI 复测时，手工触发 workflow，并把 `mac_intel_runner` 填为新 Mac x64 runner 的单个标签。
默认空值保持暂缓；不自动注册或安装 self-hosted runner。
完成同次 DMG、完整程序/运行时、CLI、三项 profile 与清理验证后，再更新本记录及验收范围。
