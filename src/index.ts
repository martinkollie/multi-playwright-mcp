import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  discoverTools,
  getOrCreateClient,
  listSessions,
  closeSession,
  closeAllSessions,
} from './session.js';

const SESSION_ID_PARAM = {
  type: 'string' as const,
  description: 'Browser session identifier. Each unique ID gets its own isolated browser.',
};

let cachedTools: Tool[] | null = null;

async function getInnerTools(): Promise<Tool[]> {
  if (!cachedTools) {
    cachedTools = await discoverTools();
  }
  return cachedTools;
}

/** Inject sessionId into each inner tool's input schema. */
function wrapToolSchemas(tools: Tool[]): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        sessionId: SESSION_ID_PARAM,
        ...(tool.inputSchema.properties ?? {}),
      },
      required: ['sessionId', ...((tool.inputSchema as any).required ?? [])],
    },
  }));
}

const MANAGEMENT_TOOLS: Tool[] = [
  {
    name: 'list_sessions',
    description: 'List all active browser session IDs',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'close_session',
    description: 'Close a browser session and free its resources',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID_PARAM,
      },
      required: ['sessionId'],
    },
  },
];

const server = new Server(
  { name: 'multi-playwright-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const innerTools = await getInnerTools();
  return { tools: [...wrapToolSchemas(innerTools), ...MANAGEMENT_TOOLS] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Handle management tools
  if (name === 'list_sessions') {
    return {
      content: [{ type: 'text', text: JSON.stringify(listSessions()) }],
    };
  }

  if (name === 'close_session') {
    const sessionId = (args as any)?.sessionId;
    if (!sessionId) throw new Error('sessionId is required');
    await closeSession(sessionId);
    return {
      content: [{ type: 'text', text: `Session "${sessionId}" closed` }],
    };
  }

  // Proxy to inner @playwright/mcp client
  const sessionId = (args as any)?.sessionId;
  if (!sessionId) throw new Error('sessionId is required');

  const { sessionId: _, ...innerArgs } = args as Record<string, unknown>;
  const client = await getOrCreateClient(sessionId);
  return await client.callTool({ name, arguments: innerArgs });
});

async function main() {
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.error(`multi-playwright-mcp shutting down (${reason})`);
    await closeAllSessions();
    await server.close();
    process.exit(exitCode);
  };

  const shutdownFrom = (reason: string, exitCode: number = 0): void => {
    void shutdown(reason, exitCode).catch((error) => {
      console.error(`Shutdown error (${reason}):`, error);
      process.exit(1);
    });
  };

  transport.onclose = () => {
    shutdownFrom('transport closed');
  };

  transport.onerror = (error) => {
    console.error('Transport error:', error);
    shutdownFrom('transport error', 1);
  };

  process.once('SIGINT', () => {
    shutdownFrom('SIGINT');
  });

  process.once('SIGTERM', () => {
    shutdownFrom('SIGTERM');
  });

  process.once('SIGHUP', () => {
    shutdownFrom('SIGHUP');
  });

  process.once('disconnect', () => {
    shutdownFrom('disconnect');
  });

  process.stdin.once('end', () => {
    shutdownFrom('stdin ended');
  });

  process.stdin.once('close', () => {
    shutdownFrom('stdin closed');
  });

  // Parent-PID watchdog: if our original parent dies (terminal closed, CLI crashed,
  // SIGKILL on parent, etc.), stdin EOF is not always delivered and we get
  // reparented to PID 1 / launchd. Poll every 5 s and exit if orphaned so macOS
  // backgroundtaskmanagementd does not accumulate stale FSEvents / Chromium
  // children for days.
  const originalPpid = process.ppid;
  const watchdog = setInterval(() => {
    const currentPpid = process.ppid;
    // ppid changed (reparented) OR original parent no longer exists.
    if (currentPpid !== originalPpid || currentPpid <= 1) {
      clearInterval(watchdog);
      shutdownFrom(`parent ${originalPpid} died (now ${currentPpid})`);
      return;
    }
    try {
      // Signal 0 just probes existence/permissions without delivering a signal.
      process.kill(originalPpid, 0);
    } catch {
      clearInterval(watchdog);
      shutdownFrom(`parent ${originalPpid} no longer reachable`);
    }
  }, 1000);
  watchdog.unref();

  // Sibling orphan sweep: every fresh MCP spawn kills any other
  // multi-playwright-mcp processes whose parent is gone. Belt-and-braces for
  // cases where SIGKILL on the parent prevented the watchdog from running
  // (e.g. parent killed before the first tick), or the dist was older than
  // the watchdog fix when an orphan was created.
  sweepOrphanedSiblings();

  await server.connect(transport);
  console.error(`multi-playwright-mcp running on stdio (ppid=${originalPpid})`);
}

/**
 * Find other `multi-playwright-mcp/dist/index.js` processes whose parent
 * PID is dead/unknown and SIGKILL them. Runs synchronously at startup so it
 * never blocks tool calls. Failures are non-fatal — this is a best-effort
 * cleanup, not a correctness requirement.
 */
function sweepOrphanedSiblings(): void {
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const myPid = process.pid;
    const out = execSync('ps -A -o pid=,ppid=,command=', {
      encoding: 'utf8',
      timeout: 2000,
    });

    const orphanPids: number[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Only target our own server, not arbitrary node/bun processes.
      if (!trimmed.includes('multi-playwright-mcp/dist/index.js')) continue;

      const match = trimmed.match(/^(\d+)\s+(\d+)\s+/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (pid === myPid) continue;

      // Parent dead/missing/launchd → orphan.
      const parentAlive = isProcessAlive(ppid);
      if (!parentAlive || ppid <= 1) {
        orphanPids.push(pid);
      }
    }

    if (orphanPids.length === 0) return;

    console.error(
      `multi-playwright-mcp: sweeping ${orphanPids.length} orphan(s): ${orphanPids.join(', ')}`,
    );
    for (const pid of orphanPids) {
      try {
        // Negative PID kills the entire process group, taking Chromium with us.
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already dead or not killable; ignore.
        }
      }
    }
  } catch (error) {
    console.error('multi-playwright-mcp: orphan sweep failed:', error);
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
