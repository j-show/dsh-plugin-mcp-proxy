# 启动异常定位

范围：历史 Chrome DevToolsActivePort 未建立、Edge Web UI 插件激活失败。当前尚未确认两个历史异常的产品根因，不能以一次绿灯认定修复。

已补充复现与诊断：浏览器输出仅以脱敏形式保留，CDP 发现期间检查子进程退出码/信号；每浏览器要求 20 次独立新文档启动。每次绑定导航 loaderId 与新 performance.timeOrigin，失败立即中止，不重试失败观察。新增回归覆盖逐次执行/失败中止和浏览器退出时立即报告。

原有 URI、原生配对、托盘生命周期及安全/清理断言保留。历史固定通过证据不覆盖本轮待执行的调查提交。

## 冷启动调查

新增 `pnpm test:browser --startup-only`，并纳入默认浏览器 CI 入口。每浏览器要求 3 套独立安装的 DSH
环境，各启动 3 个独立浏览器进程/profile；隔离 npm cache、home、APPDATA、LOCALAPPDATA 和临时目录。
报告逐次启动耗时、模块版本、脱敏错误及回收结果；失败立即停止。仅启动入口不操作已有 URI 和机器服务。
此处“全新环境”指本轮私有目录和依赖安装，不表示重装操作系统或重新安装浏览器；CI 使用新建 Windows runner。

本机冷启动发现并复现两个测试驱动缺陷，均不能替代历史异常的归因：

- 新导航的 body 尚未建立时读取 innerText，导致 Browser evaluation failed。VM 回归先复现空 body 异常，再验证等待。
- Shell 的 Settings 可先于异步 onboarding 出现；过早进入设置会被稍后的声明遮挡。
  失败页面保留声明且无客户端异常。准备流程已改为持续处理正常引导直到本机连接入口可命中，
  仅在 Settings 的 aria-expanded=false 且可命中时打开设置；回归覆盖后出现的 onboarding。

当前历史 Chrome DevToolsActivePort 缺失、Edge `web boot: ... failed` 仍保持未归因，
不以新的驱动缺陷替代历史根因。对比历史 Edge 失败提交 `3db6d18`：UI/浏览器适配源码及依赖锁文件均无变化。

本机诊断另外确认：窗口虽处于 normal 状态，页面 visibilityState=hidden；仅 CDP bringToFront
不足以获得系统前台。创建身份校验后的 Win32 前台操作被系统明确拒绝，故本机冷矩阵不能作为通过证据。
新增独立 browser foreground 阶段验证，避免将无效点击与 UI 插件启动混为一谈。
相关单元回归 18 项通过；完整默认测试 579 通过、8 跳过。

## 已验证结果

实现提交 `b96e3bcbada3b4ed4472f29e708d4d4c7c9b13ef` 的
[完整 Windows CI](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43605821033) 已通过，
checkout 为 clean；逐次原始结果及归档哈希固定于[冷启动证据](cold-browser-startup-2026-11-14.json)。

| 浏览器 | 全新 DSH 环境 | 独立进程/profile | CDP 建立耗时 | Web 设置就绪耗时 |
| --- | --- | --- | --- | --- |
| Chrome 156.0.8078.80 | 3 | 9 次全部通过 | 445–4761 ms | 1714–2297 ms |
| Edge 156.0.4314.58 | 3 | 9 次全部通过 | 706–1064 ms | 1688–2262 ms |

两种浏览器另各完成 20 次新文档启动和原有七场景生命周期、网页伪确认及托盘遮挡拒绝检查。
全部环境、浏览器进程、CA、URI 和机器服务回收通过；五项原生产物测试零跳过，十个验证命令退出码均为 0。
这些结果证明复现入口和新增驱动修正已通过实际 CI；两项历史异常本轮没有复现，仍不标记已找到根因或已修复。
