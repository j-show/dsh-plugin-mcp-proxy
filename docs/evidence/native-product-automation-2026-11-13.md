# 原生产物测试自动化

日期：2026-11-13。基线：ce314126537de96f5f643caf5df1c32c2746eaaa。

## 执行契约

```mermaid
flowchart LR
  B[成功构建与产物记录] --> H[校验专属 EXE 和 runtime 哈希及清单]
  H --> P[检查机器服务位空闲]
  P --> T[串行执行五项原生产物测试]
  T --> C[确认服务位释放及进程退出断言]
  C --> D[删除自有测试数据并写报告]
```

- `pnpm build:mcp-proxy` 发布成功后原子写入 `release/mcp-proxy/product-build.json`。
- `pnpm test:product` 不接受手动路径覆盖，不猜测“最新”目录；校验发布 EXE、构建专属 EXE 和 runtime 清单后，执行构建专属 EXE。并行发布不会在校验后替换测试对象。
- 全局运行锁覆盖结果清理、测试和最终证据写入；争锁失败不修改另一次运行的结果。各测试原有机器服务锁继续保留。
- 只探测服务位，不向预先存在的服务发停止命令。测试失败仍检查清理，服务位占用或不可确认时非零退出。
- 只接受 5 项真实通过、0 失败、0 跳过。保留原有服务及 MCP PID 退出断言；成功删除自身测试数据，失败私有现场不上传。
- release CI 在两端打包后调用同一入口；上传验证 JSON、测试结果和发布产物，不上传 `.artifacts/product-tests` 或开发身份。

## 本地证据

- 构建：`pnpm build`、`pnpm build:mcp-proxy --skip-build` 退出 0。
- 最终默认套件：`pnpm test` 退出 0；70 文件通过、2 文件跳过，561 测试通过、8 跳过。
- 类型检查：`pnpm typecheck` 退出 0。
- 原生产物：`pnpm test:product` 退出 0；5 通过、0 失败、0 跳过。
- 产品报告：serviceBefore=idle、serviceAfter=idle、cleanup=test-owned data removed。
- 新回归覆盖产物被替换/混用、校验后并发发布、路径越界、占用服务位拒绝、失败后仍做清理检查、竞争运行不得删除结果、零测试/跳过拒绝，以及只读 runtime 校验。
- 独立复审提出的共享 EXE 替换窗口及锁外结果写入问题已修复；复审无剩余可确认 P1/P2。

本地验证基于工作区，提交及远端完整流水线状态以对应 Git 历史和 Actions 运行记录为准。
本期只自动化已有五项原生产物场景，不将普通浏览器、真实模型、跨用户和多设备的待验收项视为完成。
