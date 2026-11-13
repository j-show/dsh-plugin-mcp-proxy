/** Locale-owned desktop text shared by the window and native tray. */
const zh = {
  brand: 'mcp-proxy', subtitle: '本机 MCP 连接', connections: 'DSH 连接', localMcps: '本地 MCP',
  connectionHint: '在 DSH 网页点击“连接这台电脑”，即可申请接入本机 MCP。',
  mcpHint: '所有已连接的 DSH 共用此列表。文件操作由这些 MCP 执行。',
  emptyConnections: '尚未连接 DSH', emptyMcps: '尚未添加本地 MCP', addMcp: '添加 MCP',
  disconnect: '断开', remove: '删除', cancel: '取消', save: '添加', ready: '可用', unavailable: '不可用',
  connecting: '连接中', connected: '已连接', reconnecting: '重连中', disconnected: '已断开', error: '连接异常',
  name: '服务别名', nameHint: '字母、数字、下划线或短横线，最多 32 个字符。', transport: '连接方式',
  command: '启动命令', commandHint: '可执行文件、npx 或 uvx；参数在下方单独填写。',
  args: '启动参数', argsHint: '每行一个参数，不需要外层引号。', url: 'MCP 服务 URL',
  advanced: '高级配置', env: '环境变量（JSON 对象）', headers: '请求头（JSON 对象）', cwd: '工作目录（可选）',
  roots: 'Roots（可选，每行一个目录）', workspace: '默认工作目录', show: '显示配置窗口', exit: '退出',
  disconnectConfirm: '断开会立即取消这个 DSH 的调用，其他 DSH 保持连接。是否继续？',
  removeConfirm: '删除会立即取消所有 DSH 对这个 MCP 的调用，并停止它的自有进程。是否继续？',
  invalidRequest: '配置格式无效，请检查后重试。', operationFailed: '操作未完成，请检查配置或本机诊断。',
  restartRequired: '凭据引用已变化，请退出并重新启动本机服务后重试。', pairingFailed: '关联未完成，请检查证书或回到 DSH 网页重新发起连接。',
  starting: '正在启动本机服务…', serviceReady: '本机服务运行中', startupFailed: '本机服务启动失败，请检查启动日志。',
  protocolFailed: '浏览器唤起入口尚未注册。请使用原安装配置，或先卸载旧安装的入口。', retry: '重试注册',
  stopFailed: '后台服务尚未完成停止，请稍后重试退出。', processing: '正在处理…', close: '关闭',
  configPath: '配置文件', stdio: 'stdio', http: 'Streamable HTTP', sse: 'SSE',
}
/** Dictionary keys accepted by the desktop presentation. */
export type DesktopMessageKey = keyof typeof zh
type Messages = { readonly [K in DesktopMessageKey]: string }
const en: Messages = {
  brand:'mcp-proxy',subtitle:'Local MCP connectivity',connections:'DSH connections',localMcps:'Local MCPs',
  connectionHint:'Choose “Connect this computer” in DSH Web to request access to local MCPs.',
  mcpHint:'All connected DSH servers share this list. These MCPs perform the file operations.',
  emptyConnections:'No DSH connections yet',emptyMcps:'No local MCPs yet',addMcp:'Add MCP',
  disconnect:'Disconnect',remove:'Delete',cancel:'Cancel',save:'Add',ready:'Available',unavailable:'Unavailable',
  connecting:'Connecting',connected:'Connected',reconnecting:'Reconnecting',disconnected:'Disconnected',error:'Connection error',
  name:'Service alias',nameHint:'Up to 32 letters, digits, underscores or hyphens.',transport:'Transport',
  command:'Command',commandHint:'Executable, npx or uvx; enter arguments separately below.',args:'Arguments',
  argsHint:'One argument per line, without surrounding quotes.',url:'MCP server URL',advanced:'Advanced configuration',
  env:'Environment (JSON object)',headers:'Headers (JSON object)',cwd:'Working directory (optional)',
  roots:'Roots (optional, one directory per line)',workspace:'Default working directory',show:'Show configuration',exit:'Exit',
  disconnectConfirm:'This immediately cancels calls from this DSH. Other DSH connections remain active. Continue?',
  removeConfirm:'This cancels calls to this MCP from every DSH and stops its owned process. Continue?',
  invalidRequest:'Invalid configuration. Check the fields and retry.',operationFailed:'The operation did not finish. Check configuration or local diagnostics.',
  restartRequired:'Credential references changed. Exit and restart the local service before retrying.',
  pairingFailed:'Association did not finish. Check the certificate or request a fresh connection in DSH Web.',
  starting:'Starting local service…',serviceReady:'Local service running',startupFailed:'Local service failed to start. Check the startup log.',
  protocolFailed:'The browser activation entry is not registered. Use the original installation configuration or remove its old entry first.',
  retry:'Retry registration',stopFailed:'The background service has not stopped. Retry Exit shortly.',processing:'Working…',close:'Close',
  configPath:'Configuration file',stdio:'stdio',http:'Streamable HTTP',sse:'SSE',
}
/** @param locale - requested application locale. @returns a typed localized message reader. */
export function desktopMessages(locale: string): (key: DesktopMessageKey) => string {
  const messages: Messages = locale.toLowerCase().startsWith('zh') ? zh : en
  return key => messages[key]
}
