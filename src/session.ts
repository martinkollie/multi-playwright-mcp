import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionEntry {
  server: Server;
  client: Client;
}

const sessions = new Map<string, SessionEntry>();

/**
 * Sanitize sessionId for use as a directory name.
 * Allows alphanumeric, hyphens, underscores, and dots.
 */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Returns the base directory for persistent session data, or undefined for ephemeral mode.
 * Set PLAYWRIGHT_USER_DATA_DIR to a directory path to enable persistence.
 */
function getPersistentBaseDir(): string | undefined {
  return process.env.PLAYWRIGHT_USER_DATA_DIR || undefined;
}

function getConnectionConfig(sessionId?: string) {
  const baseDir = getPersistentBaseDir();
  const persistent = !!baseDir && !!sessionId;

  const config: Record<string, unknown> = {
    browserName: 'chromium' as const,
    launchOptions: { headless: false, channel: 'chromium' },
  };

  if (persistent) {
    const dir = join(baseDir!, sanitizeSessionId(sessionId!));
    mkdirSync(dir, { recursive: true });
    config.userDataDir = dir;
    config.isolated = false;
  } else {
    config.isolated = true;
  }

  return { browser: config };
}

export async function getOrCreateClient(sessionId: string): Promise<Client> {
  const existing = sessions.get(sessionId);
  if (existing) return existing.client;

  const server = await createConnection(getConnectionConfig(sessionId));
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
