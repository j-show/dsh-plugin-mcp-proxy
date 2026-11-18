/** Simplified Chinese copy and key source for local-computer association. */
export const zh = {
  elicitationTitle: '需要你的补充信息', elicitationOpen: '打开页面', elicitationContinue: '继续',
  elicitationSubmit: '提交', elicitationDecline: '不提供', elicitationCancel: '取消请求', elicitationChoose: '请选择',
  elicitationRetained: '关闭网页后，可在请求失效前重新打开此会话继续。',
  elicitationError: '暂时无法读取或提交请求，请检查后重试。',
  nav: '本机连接', title: '连接这台电脑',
  hint: '先在这台电脑安装并启动 mcp-proxy。点击连接后，允许浏览器打开本地应用。',
  loading: '正在检查连接…', unbound: '尚未关联这台电脑', opening: '正在准备连接…',
  waiting: '等待本机服务确认…', connected: '本机 MCP 已连接', unavailable: '连接未完成，请确认本机服务已启动后重试。',
  disconnecting: '正在解除网页关联…',
  connect: '连接这台电脑', reconnect: '重新连接这台电脑', refresh: '检查连接', disconnect: '解除网页关联',
  open: '再次打开本机服务', services: '可用 MCP 服务', noServices: '已连接，尚未配置 MCP 服务。',
  turnHint: '连接用于之后提交的任务。正在执行的任务继续使用原来的电脑；关闭网页不会停止本机服务。',
} as const
/** Locale keys owned by this feature. */
export type ProxyLocaleKey = keyof typeof zh
/** English copy for the same association states and actions. */
export const en = {
  elicitationTitle: 'More information is needed', elicitationOpen: 'Open page', elicitationContinue: 'Continue',
  elicitationSubmit: 'Submit', elicitationDecline: 'Decline', elicitationCancel: 'Cancel request', elicitationChoose: 'Choose an option',
  elicitationRetained: 'You can close this page and reopen this Session before the request expires.',
  elicitationError: 'The request could not be read or submitted. Check and try again.',
  nav: 'This computer', title: 'Connect this computer',
  hint: 'Install and start mcp-proxy on this computer. After connecting, allow your browser to open the local application.',
  loading: 'Checking the connection…', unbound: 'This computer is not associated', opening: 'Preparing the connection…',
  waiting: 'Waiting for the local service…', connected: 'Local MCP connected', unavailable: 'Connection did not complete. Check that the local service is running and retry.',
  disconnecting: 'Removing browser association…',
  connect: 'Connect this computer', reconnect: 'Reconnect this computer', refresh: 'Check connection', disconnect: 'Remove browser association',
  open: 'Open the local service again', services: 'Available MCP services', noServices: 'Connected; no MCP services are configured.',
  turnHint: 'The connection applies to subsequent submissions. Running tasks keep their original computer; closing this page does not stop the local service.',
} satisfies Record<ProxyLocaleKey, string>
/** Dictionary namespace for this connection surface. */
export const NS = 'mcp-proxy'
