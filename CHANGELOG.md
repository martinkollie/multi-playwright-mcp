## 2026-05-15

- **`create_session` is now optional, not required.** Sessions auto-create on first `browser_*` call with default settings (isolated chromium, non-headless). `create_session` is only needed when you want to load Chrome extensions. Fixes spurious `extensions array is required` errors when agents called it reflexively with no extensions.
- **`extensions` parameter is now optional on `create_session`.** Calling with just `sessionId` produces a default session, same as auto-create.
- Updated tool description to make the optional nature explicit so MCP clients stop calling it by default.

## 2026-04-27

- **Added `create_session` tool** for launching browser sessions with Chrome extensions loaded. Accepts an array of absolute paths to unpacked extension directories. Uses `--load-extension` and `--disable-extensions-except` Chromium flags with a temporary persistent profile. Temp profile is cleaned up on `close_session`.

## 2026-04-25

- **Catch orphans the watchdog misses** — when stdin is busy (e.g. attached to `/dev/zero`) or other edge cases prevent the JS event loop from servicing timers, the parent-PID watchdog from the prior fix can fail to fire, leaving an MCP node alive with `ppid=1`. Stale orphans were still observed accumulating after the 5s watchdog landed.
  - Added a **startup orphan sweep** (`sweepOrphanedSiblings`) that runs once at boot, scans `ps -A` for sibling `multi-playwright-mcp/dist/index.js` processes whose `ppid` is dead or reparented to launchd (`<= 1`), and `SIGKILL`s their process group. Verified end-to-end: a freshly-started MCP correctly killed a pre-existing orphan with `ppid=1`.
  - **Tightened the watchdog interval from 5s to 1s** so genuinely-orphaned nodes shut down faster and have less time to spawn new Chromium children before exit.

## 2026-04-17

- **Fix orphaned MCP processes accumulating for days** — macOS `backgroundtaskmanagementd` was tracking 26+ stale `multi-playwright-mcp` nodes (oldest from Tuesday) and their Chromium children, driving BTM RSS to 100GB+. The existing shutdown path relied on stdin EOF / `SIGTERM` / disconnect, which are not always delivered when the parent (Copilot CLI, editor, etc.) is killed abruptly — the child gets reparented to launchd and lives forever.
  - Added a **`SIGHUP` handler** so terminal-close propagation shuts the server down cleanly.
  - Added a **parent-PID watchdog** (`setInterval`, 5 s, `unref`'d) that records the original `process.ppid` at startup and exits the server if the parent process goes away or we get reparented. Exits via the normal shutdown path so inner Playwright sessions and Chromium children are closed properly.

## 2026-03-23

- Added explicit shutdown handling for stdio transport closure, stdin end/close, `SIGTERM`, and process disconnect events so stale MCP wrapper processes are less likely to accumulate after client restarts or disconnects.
