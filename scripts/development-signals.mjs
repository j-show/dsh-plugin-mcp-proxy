// Development-only Node preload: use the CLI's own signal handlers on Windows.
// An inherited IPC channel permits graceful shutdown without taskkill/SIGTERM force.
process.on('message', message => {
  if (message === 'mcp-development-stop') process.emit('SIGINT')
})
// One-shot profile commands must not stay alive solely to listen for shutdown.
process.channel?.unref()
