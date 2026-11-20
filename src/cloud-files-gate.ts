// Dispatch before any handler reads a body, creates media, or invokes an agent.
export const MUTATING_ROUTES = [
    'update', 'structure', 'move', 'resize', 'scale', 'text', 'replace', 'layout', 'overrides', 'pages', 'widgets', 'shaders', 'videos', 'images', 'history', 'variations', 'agent', 'selection-colors', 'repeat', 'component', 'paste', 'delete', 'align', 'distribute', 'group', 'ungroup', 'boolean', 'vector', 'path', 'swap', 'theme', 'variables', 'fonts',
] as const;
const SAFE = new Set(['/api/flush', '/api/mcp/hello', '/api/bridge/poll', '/api/bridge/ack', '/api/bridge/state', '/api/mcp/connect', '/api/usage/count', '/api/copy-as', '/api/export']);
export function readOnlyRoute(method: string, pathname: string): boolean {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
        return false;
    if (pathname.startsWith('/api/comments/') || pathname.startsWith('/api/cloud/') || SAFE.has(pathname))
        return false;
    // Fail closed for new edit routes too; a route need not be remembered in this table to be protected.
    return pathname.startsWith('/api/');
}
