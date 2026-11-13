# Windows URI 短路径回归

日期：2026-11-13。基线：8ffffdf3843929d73d6e033b1813f107a89bf606。

原始失败运行：[Windows verification 43403841827](https://github.com/j-show/dsh-plugin-mcp-proxy/actions/runs/43403841827)。
全新 runner 冷缓存安装、初始化、构建与类型检查成功；native-windows 安装/升级/卸载测试失败，后续打包未执行。

## 定位

- 将本机 TEMP/TMP 指向任务专用临时目录的 Win32 8.3 别名后，同一测试稳定出现 --register 失败，清理时 --unregister 也失败。
- 新增 native/short 参数化回归：修复前 native 通过、short 失败；没有跳过原有安装、升级和卸载行为。
- 原生 helper 取到的 Assembly.Location 与 receipt 中拼接的路径可能使用不同的长/短路径表示。注册命令进行精确字符串比较时，即使文件归属相同也会拒绝升级。

## 修复与约束

通过 GetLongPathName 展开受信的当前 helper 路径，再用其规范目录和已通过正则校验的前驱 hash 文件名构造前驱命令。注册表中的 owner 和完整命令仍按原规则校验，不规范化任意未知注册命令，不覆盖其他所有者。

不能对前驱文件无条件调用要求文件存在的 API：清理前驱与更新 receipt 之间可能中断。补充该窗口的恢复回归，中间实现先在 native/short 两分支复现失败，再修复为无需前驱存在。

额外验证同一 owner 下的无关注册命令仍导致 register/unregister 返回拒绝，防止路径兼容修复放宽所有权边界。8.3 别名特有的变体只在测试卷未提供不同别名时显式跳过，其余原生用例继续执行。

## 验证

- `pnpm test`：退出 0；69 文件通过、2 文件跳过，552 测试通过、8 跳过；包含 native/short 升级、卸载、崩溃恢复及无关命令拒绝。
- `pnpm typecheck`：退出 0。
- 独立代码复审：前驱已删除的恢复问题修复后，无剩余可确认 P1/P2；`git diff --check` 通过。

本地完整测试、类型检查及后续修复提交的远端完整流水线结果，由此次提交的实际执行输出与 GitHub Actions 记录追踪；原始源码指纹清单保持为基线证据，不改写历史通过结果或掩盖历史失败。真实模型、多设备和普通浏览器产品验收仍按原 A 项保留。
