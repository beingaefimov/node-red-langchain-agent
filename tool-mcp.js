import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export default function (RED) {
  function McpClientNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.transport = config.transport || 'stdio';
    node.command = config.command;
    node.args = config.args; 
    node.sseUrl = config.sseUrl;
    node.envPairs = config.envPairs; 
    node.includeFilter = config.includeFilter; 
    node._mcpClient = null;

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

    // Expose getTool for agent-api to call directly
    node.getTool = async function() {
      const { client, tools } = await connectAndList();
      node._mcpClient = client; // Save reference for cleanup
      
      const lcTools = [];
      const wanted = node.includeFilter
        ? new Set(node.includeFilter.split(',').map((s) => s.trim()).filter(Boolean))
        : null;

      for (const t of tools) {
        if (wanted && !wanted.has(t.name)) continue;
        const props = t.inputSchema && t.inputSchema.properties;
        const shape = {};
        if (props && typeof props === 'object') {
          for (const [k, v] of Object.entries(props)) {
            shape[k] = z.any().describe(v.description || k);
          }
        }
        lcTools.push(
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
      return lcTools;
    };

    node.on('input', async function (msg, send, done) {
      try {
        const tools = await node.getTool();
        msg.langchain = msg.langchain || {};
        msg.langchain.tools = msg.langchain.tools || [];
        msg.langchain.tools.push(...tools);
        msg.langchain.mcpClient = node._mcpClient; // for closing later
        
        node.status({ text: `${tools.length} tools`, fill: 'green', shape: 'dot' });
        send(msg); done && done();
      } catch (err) {
        node.status({ text: 'mcp error', fill: 'red', shape: 'dot' });
        done && done(err);
      }
    });

    node.on('close', function () {
      if (node._mcpClient) {
        node._mcpClient.close().catch(() => {});
      }
    });
  }

  RED.nodes.registerType('langchain-mcp-client', McpClientNode);
};