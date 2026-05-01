# Multi-Playwright MCP Server

A multi-session wrapper around Microsoft's [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp). Every tool from the official Playwright MCP server is available, with an added `sessionId` parameter that lets you run **multiple isolated browser instances** concurrently.

## Why?

The official `@playwright/mcp` runs a single browser per server instance. This wrapper creates a separate isolated browser for each `sessionId`, so an MCP client can automate multiple sites in parallel without conflicts.

## Install

```bash
npm install
npx playwright install chromium   # install browser binary
npm run build
```

## Usage

Add to your MCP client config (e.g. Copilot CLI, Claude Desktop, VS Code):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["/path/to/multi-playwright-mcp/dist/index.js"]
    }
  }
}
```

## Persistent Sessions

By default, each session uses an ephemeral browser profile that is discarded when the session closes. To persist login state, cookies, and localStorage across sessions, set the `PLAYWRIGHT_USER_DATA_DIR` environment variable:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["/path/to/multi-playwright-mcp/dist/index.js"],
      "env": {
        "PLAYWRIGHT_USER_DATA_DIR": "/home/user/.playwright-sessions"
      }
    }
  }
}
```

Each `sessionId` gets its own subdirectory under that path (e.g. `/home/user/.playwright-sessions/session-a/`). When you close and reopen a session with the same ID, the browser profile is reused — logins survive across restarts.

| Mode | `PLAYWRIGHT_USER_DATA_DIR` | Behavior |
|------|---------------------------|----------|
| Ephemeral (default) | unset | Fresh browser per session, data lost on close |
| Persistent | set to a directory | Profile saved per sessionId, survives restarts |

## Tools

All tools from [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) are proxied with an added `sessionId` parameter. Each unique `sessionId` gets its own headless Chromium browser.

### Browser Tools (from @playwright/mcp)

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_click` | Click an element (accessibility ref) |
| `browser_type` | Type text into an element |
| `browser_fill_form` | Fill form fields |
| `browser_snapshot` | Accessibility tree snapshot of the page |
| `browser_take_screenshot` | Capture a screenshot |
| `browser_evaluate` | Run JavaScript in the page |
| `browser_press_key` | Press a keyboard key |
| `browser_hover` | Hover over an element |
| `browser_select_option` | Select a dropdown option |
| `browser_drag` | Drag an element |
| `browser_tabs` | Manage browser tabs |
| `browser_navigate_back` | Go back in history |
| `browser_file_upload` | Upload files |
| `browser_wait_for` | Wait for a condition |
| `browser_close` | Close the browser |
| `browser_resize` | Resize the viewport |
| `browser_console_messages` | Get console messages |
| `browser_network_requests` | Get network requests |
| `browser_handle_dialog` | Handle browser dialogs |
| `browser_run_code` | Run Playwright code |
| `browser_install` | Install browser binary |

### Session Management

| Tool | Description |
|------|-------------|
| `list_sessions` | List all active session IDs |
| `close_session` | Close a session and free its browser |

## Architecture

```
MCP Client
  │
  ▼
┌─────────────────────────────┐
│  multi-playwright-mcp       │  (outer MCP server, stdio)
│  ┌────────────────────────┐ │
│  │ sessionId → inner      │ │
│  │ "s1" → @playwright/mcp │ │  ← isolated Chromium #1
│  │ "s2" → @playwright/mcp │ │  ← isolated Chromium #2
│  │ "s3" → @playwright/mcp │ │  ← isolated Chromium #3
│  └────────────────────────┘ │
└─────────────────────────────┘
```

Each session uses `createConnection()` from `@playwright/mcp` with in-memory transports, giving full access to the official tool set with complete isolation between sessions.
