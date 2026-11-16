// An inherited IPC channel ties this service to the owning desktop supervisor.
// A supervisor crash closes the channel; use DSH's real graceful signal path.
process.once('disconnect', () => {
  if (process.listenerCount('SIGINT')) process.emit('SIGINT')
  else process.exit(1)
})
process.channel?.unref()
