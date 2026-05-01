import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface SessionEntry {
  server: Server;
  client: Client;
}

const sessions = new Map<string, SessionEntry>();

function isHeadless(): boolean {
  const env = process.env.PLAYWRIGHT_HEADLESS;
  if (env !== undefined) return env !== '0' && env.toLowerCase() !== 'false';
  return !process.env.DISPLAY;
}

function getConnectionConfig() {
  return {
    browser: {
      browserName: 'chromium' as const,
      isolated: true,
      launchOptions: { headless: isHeadless(), channel: 'chromium' },
    },
  };
}

export async function getOrCreateClient(sessionId: string): Promise<Client> {
  const existing = sessions.get(sessionId);
  if (existing) return existing.client;

  const server = await createConnection(getConnectionConfig());
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client({ name: `session-${sessionId}`, version: '1.0.0' });
  await client.connect(clientTransport);

  sessions.set(sessionId, { server, client });
  return client;
}

/** Discover available tools from a temporary inner connection. */
export async function discoverTools(): Promise<Tool[]> {
  const server = await createConnection(getConnectionConfig());
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
