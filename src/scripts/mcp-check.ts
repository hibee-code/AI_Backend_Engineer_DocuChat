// Checks the external MCP servers in MCP_EXTERNAL_SERVERS (.env) without
// running the agent (no Claude calls, no cost):
//   npm run mcp:check                      lists each server's exposed tools
//   npm run mcp:check -- "hello"           also calls any exposed echo tool
import { config } from '../lib/config';
import { discoverExternalTools } from '../mcp/client';

async function main() {
  const servers = config.MCP_EXTERNAL_SERVERS;
  if (servers.length === 0) {
    console.log('MCP_EXTERNAL_SERVERS is empty: no external MCP servers configured.');
    return;
  }

  const toolset = await discoverExternalTools(servers);
  try {
    for (const server of servers) {
      const prefix = `mcp_${server.name}_`;
      const names = toolset.tools.map((t) => t.name).filter((n) => n.startsWith(prefix));
      console.log(
        names.length
          ? `✔ ${server.name} (${server.url}): ${names.join(', ')}`
          : `✘ ${server.name} (${server.url}): not reachable or no allowed tools (see log above)`,
      );
    }

    const message = process.argv[2];
    if (message) {
      for (const server of servers) {
        const echo = `mcp_${server.name}_echo`;
        if (!toolset.has(echo)) continue;
        const result = await toolset.call(
          echo,
          { message },
          { userId: 'mcp-check', correlationId: 'mcp-check' },
        );
        // Line 1 is the untrusted-output wrapper tag; line 2 is the tool's text
        console.log(`${echo} →`, result.isError ? result.content : result.content.split('\n')[1]);
      }
    }
  } finally {
    await toolset.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
