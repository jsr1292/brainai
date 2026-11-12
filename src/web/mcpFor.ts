/**
 * The MCP server one connection gets: the /mcp route builds it per request, and Settings builds the same one to know
 * which tools that connection should see now (guided setup, round 2 §17b).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Access } from '../discussions/types.js';
import { buildMcpServer } from '../mcp/server.js';
import type { AppDeps } from './app.js';
import { healthOf } from './healthData.js';

export function mcpServerFor(d: AppDeps, o: { actorName: string; access: Access; projects?: string[]; clientId?: string; grantId?: string; onSetup?: (n: number) => void }): McpServer {
  return buildMcpServer(d.service, o.actorName, {
    registry: d.registry,
    growth: d.growth,
    learning: d.learning,
    pages: d.pages,
    notes: d.notes,
    discussions: d.discussions,
    reviews: d.reviews,
    mode: d.mode ?? 'personal',
    access: o.access,
    askCommands: d.askCommands,
    clientId: o.clientId,
    images: d.images,
    diagramChecks: d.diagramChecks,
    uploadLinks: d.uploadLinks,
    grantId: o.grantId,
    publicUrl: d.publicUrl,
    projects: o.projects,
    onSetup: o.onSetup,
    skills: d.skills,
    health: () => healthOf(d, d.now()),
  });
}
