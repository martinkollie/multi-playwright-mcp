## 2026-03-23

- Added explicit shutdown handling for stdio transport closure, stdin end/close, `SIGTERM`, and process disconnect events so stale MCP wrapper processes are less likely to accumulate after client restarts or disconnects.
