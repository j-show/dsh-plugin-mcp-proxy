# 已确认历史基线

本目录保留 TK-20261102-local-mcp-access 的完整中英文已确认需求和方案 A，供追溯，不要求访问原仓库。现行开发从[需求](../requirements.md)、[技术方案](../design.md)、[配置](../configuration.md)和[验收](../acceptance.md)开始。

| 历史文件 | 用途 |
| --- | --- |
| [需求中文](TK-20261102-local-mcp-access/requirement.zh.md)／[English](TK-20261102-local-mcp-access/requirement.md) | B1—B28 原有原话、职责、非目标、联合验收及确认记录 |
| [方案 A 中文](TK-20261102-local-mcp-access/proposal.zh.md)／[English](TK-20261102-local-mcp-access/proposal.md) | 已批准的完整路线、配对、插件扩展点、路由、回调及持久化设计 |
| [导入清单](TK-20261102-local-mcp-access/manifest.json) | 导入日期、原文件和导入文件 SHA256、允许的排版/链接转换 |

迁移保留正文，不复制消费项目的实现、凭据、测试运行目录或仓库级约束。只增加历史提示，将无法在独立项目解析的旧相对源码链接转成原路径文字，将本项目产品指南改成本地链接，并规范 UTF-8/LF；原文件哈希与导入哈希因此分别记录。旧相对路径是历史记号，不是构建依赖或要求恢复的目录。

导入 Markdown 的哈希按无 BOM 的 UTF-8、LF 换行计算；若 Git 在 Windows checkout 转为 CRLF，复核时先规范回 LF。原文件 sourceSha256 记录导入当时的原始字节，不用于要求另一份原仓库继续存在。

## 后续明确变更

| 内容 | 对现行开发的影响 |
| --- | --- |
| 两个完整交付物、方案 A、B18—B20 及插件方式 | 保留已确认目标；内部模块不是独立部署产品 |
| M4 Tauri 与跨平台构建 | 取代历史 Electron/单 EXE 限定；Windows x86/x64、Mac ARM、Ubuntu 原生验证范围见现行验收，Intel DMG 仍按用户决定暂缓 |
| 多 DSH、共享 MCP、严格来源归属 | B23—B28 生效；按连接和代际区分调用，不改变下游参数 |
| 首地址自动连接及退出无二次确认 | 自动激活替代早期的首次本地允许/拒绝选择；手动断开仍保留；退出直接清理 |
| 两个交付包 | 当前仅有 `@jshow/dsh-plugin-mcp-proxy` 与 `@jshow/app-mcp-proxy`；内部目录为普通源码模块，不再是独立包 |
| 独立应用状态目录 | 当前为 `%LOCALAPPDATA%/McpProxy/`；历史 CurrentAgent 目录不是新默认值 |
| 固定 DSH 最小补丁获批准 | 仅补充四个必需事件名；开发依赖和目标安装分别验证，不弱化恢复规则 |

历史文本中的“已批准”表示目标与方案获准，不表示已实现或通过验收。历史要求与代码不一致时记录缺口，不静默将现状改成目标。历史基线不持续改写；今后需求变更更新现行文档并记录依据。
