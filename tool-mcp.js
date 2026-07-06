'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { z } = require('zod');

// MCP client sub-node: connects to an MCP server (stdio or sse), pulls the
// tool list, and exposes each one as a DynamicStructuredTool. Push them onto
// msg.langchain.tools so the upstream agent can pick them up
module.exports = function (RED) {
  function McpClientNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.transport = config.transport || 'stdio';
    node.command = config.command;
    node.args = config.args; // newline-separated
    node.sseUrl = config.sseUrl;
    node.envPairs = config.envPairs; // KEY=VALUE lines
    node.includeFilter = config.includeFilter; // comma-separated names

    async function connectAndList() {
      const env = {};
      if (node.envPairs) {
        for (const line of node.envPairs.split(/\r?\n/)) {
          const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
          if (m) env[m[1]] = m[2];
        }
      }
      const args = node.args ? node.args.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
      let transport;
      if (node.transport === 'sse') {
        transport = new SSEClientTransport(new URL(node.sseUrl));
      } else {
        transport = new StdioClientTransport({ command: node.command, args, env });
      }
      const client = new Client({ name: 'node-red-mcp', version: '0.1.0' }, { capabilities: {} });
      await client.connect(transport);
      const { tools } = await client.listTools();
      return { client, tools };
    }

    node.on('input', async function (msg, send, done) {
      try {
        const { client, tools } = await connectAndList();
        const wanted = node.includeFilter
          ? new Set(node.includeFilter.split(',').map((s) => s.trim()).filter(Boolean))
          : null;
        msg.langchain = msg.langchain || {};
        msg.langchain.tools = msg.langchain.tools || [];
        msg.langchain.mcpClient = client;

        for (const t of tools) {
          if (wanted && !wanted.has(t.name)) continue;
          // Build a minimal zod schema from inputSchema.properties (loose - pass-through object)
          const props = t.inputSchema && t.inputSchema.properties;
          const shape = {};
          if (props && typeof props === 'object') {
            for (const [k, v] of Object.entries(props)) {
              shape[k] = z.any().describe(v.description || k);
            }
          }
          msg.langchain.tools.push(
            new DynamicStructuredTool({
              name: `mcp_${t.name}`.slice(0, 64),
              description: t.description || `MCP tool ${t.name}`,
              schema: z.object(Object.keys(shape).length ? shape : { input: z.string().optional() }),
              func: async (args) => {
                const res = await client.callTool({ name: t.name, arguments: args });
                if (res && Array.isArray(res.content)) {
                  return res.content.map((c) => (c.text ? c.text : JSON.stringify(c))).join('\n');
                }
                return JSON.stringify(res);
              },
            }),
          );
        }
        node.status({ text: `${msg.langchain.tools.length} tools`, fill: 'green', shape: 'dot' });
        send(msg); done && done();
      } catch (err) {
        node.status({ text: 'mcp error', fill: 'red', shape: 'dot' });
        done && done(err);
      }
    });

    node.on('close', function () {
      const c = node.context().global.get('langchain_mcp_client');
      if (c) c.close().catch(() => {});
    });
  }

  RED.nodes.registerType('langchain-mcp-client', McpClientNode);
};
