import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface SessionOptions {
  videoDir?: string;
  videoSize?: { width: number; height: number };
}

export interface SessionEntry {
  server: Server;
  client: Client;
  options?: SessionOptions;
}

const sessions = new Map<string, SessionEntry>();

type ConnectionConfig = NonNullable<Parameters<typeof createConnection>[0]>;

function buildConnectionConfig(options?: SessionOptions): ConnectionConfig {
  const config: ConnectionConfig = {
    browser: {
      browserName: 'chromium',
      isolated: true,
      launchOptions: { headless: false, channel: 'chromium' },
    },
  };

  if (options?.videoDir && options?.videoSize) {
    config.saveVideo = {
      width: options.videoSize.width,
      height: options.videoSize.height,
    };
    config.outputDir = options.videoDir;
  }

  return config;
}

export async function createSession(
  sessionId: string,
  options?: SessionOptions
): Promise<{ created: boolean; videoEnabled: boolean }> {
  if (sessions.has(sessionId)) {
    throw new Error(`Session "${sessionId}" already exists`);
  }

  const config = buildConnectionConfig(options);
  const server = await createConnection(config);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: `session-${sessionId}`, version: '1.0.0' });
  await client.connect(clientTransport);

  sessions.set(sessionId, { server, client, options });
  return {
    created: true,
    videoEnabled: !!(options?.videoDir && options?.videoSize),
  };
}

export async function getOrCreateClient(sessionId: string): Promise<Client> {
  const existing = sessions.get(sessionId);
  if (existing) return existing.client;

  const config = buildConnectionConfig();
  const server = await createConnection(config);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client({ name: `session-${sessionId}`, version: '1.0.0' });
  await client.connect(clientTransport);

  sessions.set(sessionId, { server, client });
  return client;
}

/** Discover available tools from a temporary inner connection. */
export async function discoverTools(): Promise<Tool[]> {
  const config = buildConnectionConfig();
  const server = await createConnection(config);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'tool-discovery', version: '1.0.0' });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();

  await client.close();
  await server.close();

  return tools;
}

export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

export async function closeSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  await entry.client.close();
  await entry.server.close();
  sessions.delete(sessionId);
}

export async function closeAllSessions(): Promise<void> {
  for (const id of sessions.keys()) {
    await closeSession(id);
  }
}
