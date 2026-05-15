import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
// Minimal config type matching @playwright/mcp's Config.browser subset
type PlaywrightMcpConfig = {
  browser?: {
    browserName?: 'chromium' | 'firefox' | 'webkit';
    isolated?: boolean;
    userDataDir?: string;
    launchOptions?: {
      headless?: boolean;
      channel?: string;
      args?: string[];
    };
  };
};
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SessionEntry {
  server: Server;
  client: Client;
  userDataDir?: string;
}

export interface SessionConfig {
  extensions?: string[];
}

const sessions = new Map<string, SessionEntry>();
const sessionConfigs = new Map<string, SessionConfig>();

const DEFAULT_CONFIG: PlaywrightMcpConfig = {
  browser: {
    browserName: 'chromium' as const,
    isolated: true,
    launchOptions: { headless: false, channel: 'chromium' },
  },
};

export function configureSession(sessionId: string, config: SessionConfig): void {
  if (sessions.has(sessionId)) {
    throw new Error(`Session "${sessionId}" already exists. Configure before first use.`);
  }
  sessionConfigs.set(sessionId, config);
}

function buildConfig(sessionId: string): { config: PlaywrightMcpConfig; userDataDir?: string } {
  const sessionConfig = sessionConfigs.get(sessionId);

  if (!sessionConfig?.extensions?.length) {
    return { config: DEFAULT_CONFIG };
  }

  // Validate extension paths
  for (const ext of sessionConfig.extensions) {
    if (!fs.existsSync(ext)) {
      throw new Error(`Extension path does not exist: ${ext}`);
    }
  }

  const extensionPaths = sessionConfig.extensions.map(p => path.resolve(p));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-'));

  return {
    userDataDir,
    config: {
      browser: {
        browserName: 'chromium' as const,
        isolated: false,
        userDataDir,
        launchOptions: {
          headless: false,
          channel: 'chromium',
          args: [
            `--disable-extensions-except=${extensionPaths.join(',')}`,
            `--load-extension=${extensionPaths.join(',')}`,
          ],
        },
      },
    },
  };
}

export async function getOrCreateClient(sessionId: string): Promise<Client> {
  const existing = sessions.get(sessionId);
  if (existing) return existing.client;

  const { config, userDataDir } = buildConfig(sessionId);
  const server = await createConnection(config);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client({ name: `session-${sessionId}`, version: '1.0.0' });
  await client.connect(clientTransport);

  sessions.set(sessionId, { server, client, userDataDir });
  return client;
}

/** Discover available tools from a temporary inner connection. */
export async function discoverTools(): Promise<Tool[]> {
  const server = await createConnection(DEFAULT_CONFIG);
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

  // Clean up temp user data dir from extension sessions
  if (entry.userDataDir) {
    fs.rm(entry.userDataDir, { recursive: true, force: true }, () => {});
  }

  sessions.delete(sessionId);
  sessionConfigs.delete(sessionId);
}

export async function closeAllSessions(): Promise<void> {
  for (const id of sessions.keys()) {
    await closeSession(id);
  }
}
