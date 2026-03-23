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

  process.once('disconnect', () => {
    shutdownFrom('disconnect');
  });

  process.stdin.once('end', () => {
    shutdownFrom('stdin ended');
  });

  process.stdin.once('close', () => {
    shutdownFrom('stdin closed');
  });

  await server.connect(transport);
  console.error('multi-playwright-mcp running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
