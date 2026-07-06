import { createAgent } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import { randomUUID } from 'crypto';

const memoryCheckpointer = new MemorySaver();

export default function (RED) {
  function AgentApiNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.route = config.route || '/agent/run';
    node.maxIterations = parseInt(config.maxIterations || '10', 10);
    node.maxExecutionTime = parseInt(config.maxExecutionTime || '120', 10);
    node.returnIntermediateSteps = config.returnIntermediateSteps === true || config.returnIntermediateSteps === 'true';
    node.systemMessage = config.systemMessage || 'You are a helpful AI assistant. Think step by step and use tools when they help.';
    node.llmNode = config.llmNode;
    node.toolNodes = (config.toolNodes || '').split(',').map((s) => s.trim()).filter(Boolean);
    node.apiKey = config.apiKey;

    async function buildExecutor(req, sessionId) {
      const llmNode = RED.nodes.getNode(node.llmNode);
      if (!llmNode) throw new Error('agent-api: llmNode not configured');
      const llm = await llmNode.getLlm(req.body || {});
      
      const tools = [];
      const mcpClientsToClose = [];
      
      for (const id of node.toolNodes) {
        const tNode = RED.nodes.getNode(id);
        if (!tNode) continue;
        if (typeof tNode.getTool === 'function') {
          const t = await tNode.getTool();
          if (Array.isArray(t)) {
            tools.push(...t);
            if (tNode._mcpClient) mcpClientsToClose.push(tNode._mcpClient);
          } else {
            tools.push(t);
          }
        }
      }

      const agent = createAgent({
        model: llm,
        tools,
        systemPrompt: node.systemMessage,
        checkpointer: memoryCheckpointer
      });

      return { agent, mcpClientsToClose };
    }

    async function streamExecutor(agent, input, res, requestId, sessionId, mcpClientsToClose) {
      const started = Date.now();
      let finalOutput = '';
      const steps = [];
      let stepN = 0;
      let aborted = false;
      
      const sseEvent = (event, data) => {
        if (res.writableEnded || aborted) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      res.on('close', () => { aborted = true; });
      sseEvent('start', { requestId, input, ts: started });

      try {
        const config = {
          configurable: { thread_id: sessionId || 'default' },
          recursion_limit: node.maxIterations + 1, 
          timeout: node.maxExecutionTime * 1000
        };
        
        const eventStream = await agent.streamEvents(
          { messages: [{ role: 'user', content: input }] },
          { version: 'v2', ...config }
        );

        for await (const ev of eventStream) {
          if (aborted) break;

          if (ev.event === 'on_chat_model_stream' || ev.event === 'on_llm_stream') {
            const chunk = ev.data && ev.data.chunk;
            if (!chunk) continue;
            const piece = chunk.content || chunk.text || (typeof chunk === 'string' ? chunk : null);
            if (!piece) continue;
            sseEvent('token', { delta: typeof piece === 'string' ? piece : JSON.stringify(piece) });
            if (typeof piece === 'string') finalOutput += piece;
          } else if (ev.event === 'on_llm_end') {
            const out = ev.data && ev.data.output;
            if (out && Array.isArray(out.generations) && out.generations[0] && Array.isArray(out.generations[0])) {
              const text = out.generations[0].map((g) => g.text || (g.message && g.message.content) || '').join('');
              if (text && !finalOutput) finalOutput = text;
            }
          } else if (ev.event === 'on_tool_start') {
            stepN += 1;
            sseEvent('step', { n: stepN, label: 'tool-call' });
            const input_ = ev.data && (ev.data.input || ev.data.inputs);
            sseEvent('tool_call', { step: stepN, tool: ev.name, input: input_ });
            steps.push({ type: 'tool_call', tool: ev.name, input: input_ });
          } else if (ev.event === 'on_tool_end') {
            const out = ev.data && (ev.data.output || ev.data.result);
            const text = typeof out === 'string' ? out : (out && out.toString ? out.toString() : JSON.stringify(out));
            sseEvent('tool_result', { step: stepN, tool: ev.name, output: text });
            steps.push({ type: 'tool_result', tool: ev.name, output: text });
          }
        }

        sseEvent('final', {
          requestId,
          output: finalOutput,
          steps: node.returnIntermediateSteps ? steps : undefined,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        sseEvent('error', { requestId, message: err.message, stack: err.stack });
      } finally {
        if (!res.writableEnded) res.end();
        for (const c of mcpClientsToClose) {
          c.close().catch(() => {});
        }
      }
    }

    if (!RED._langchainApiMounted) {
      RED.httpNode.post('/langchain-agent/ping', (_req, res) => {
        res.json({ ok: true, name: 'node-red-contrib-langchain-agent', version: '1.0.0' });
      });
      RED._langchainApiMounted = true;
    }
    
    if (!RED._langchainApiRoutes) RED._langchainApiRoutes = new Set();
    if (RED._langchainApiRoutes.has(node.route)) {
      node.warn(`agent-api: route ${node.route} already registered by another agent-api node`);
    } else {
      RED._langchainApiRoutes.add(node.route);
      RED.httpNode.post(node.route, async (req, res) => {
        const requestId = randomUUID();
        const body = req.body || {};
        const input = body.input || body.question || '';
        const sessionId = body.sessionId ? String(body.sessionId) : null;
        const stream = body.stream === true || body.stream === 'true';

        if (node.apiKey && req.headers.authorization !== `Bearer ${node.apiKey}`) {
          res.status(401).json({ error: 'unauthorized', requestId }); return;
        }
        if (!input) {
          res.status(400).json({ error: 'input is required', requestId }); return;
        }

        if (!stream) {
          try {
            const { agent, mcpClientsToClose } = await buildExecutor(req, sessionId);
            setImmediate(async () => {
              const started = Date.now();
              node.status({ text: 'reasoning...', fill: 'yellow', shape: 'ring' });
              try {
                const config = {
                  configurable: { thread_id: sessionId || 'default' },
                  recursion_limit: node.maxIterations + 1,
                  timeout: node.maxExecutionTime * 1000
                };
                
                const result = await agent.invoke(
                  { messages: [{ role: 'user', content: input }] },
                  config
                );
                
                const lastMsg = result.messages[result.messages.length - 1];
                const outputText = typeof lastMsg.content === 'string' 
                  ? lastMsg.content 
                  : JSON.stringify(lastMsg.content);

                node.status({ text: `done in ${((Date.now() - started) / 1000).toFixed(1)}s`, fill: 'green', shape: 'dot' });
                res.json({
                  requestId,
                  input,
                  output: outputText,
                  intermediateSteps: node.returnIntermediateSteps ? result.messages : undefined,
                  durationMs: Date.now() - started,
                });
              } catch (err) {
                node.status({ text: 'error', fill: 'red', shape: 'dot' });
                node.error(err);
                res.status(500).json({ requestId, error: err.message });
              } finally {
                for (const c of mcpClientsToClose) c.close().catch(() => {});
              }
            });
          } catch (err) {
            res.status(500).json({ requestId, error: err.message });
          }
          return;
        }
        
        // SSE mode
        try {
          const { agent, mcpClientsToClose } = await buildExecutor(req, sessionId);
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders && res.flushHeaders();
          node.status({ text: 'streaming...', fill: 'yellow', shape: 'ring' });
          setImmediate(() => streamExecutor(agent, input, res, requestId, sessionId, mcpClientsToClose).then(() => {
            node.status({ text: 'streamed', fill: 'green', shape: 'dot' });
          }));
        } catch (err) {
          res.status(500).json({ requestId, error: err.message });
        }
      });
    }

    if (!RED._langchainApiRoutes.has(node.route + '/events')) {
      RED._langchainApiRoutes.add(node.route + '/events');
      RED.httpNode.get(node.route + '/events', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders && res.flushHeaders();
        res.write(`event: ready\ndata: ${JSON.stringify({ requestId: randomUUID() })}\n\n`);
        const keepalive = setInterval(() => {
          if (res.writableEnded) { clearInterval(keepalive); return; }
          res.write(`: keepalive ${Date.now()}\n\n`);
        }, 15000);
        req.on('close', () => clearInterval(keepalive));
      });
    }

    node.on('close', function () {
      if (RED._langchainApiRoutes) {
        RED._langchainApiRoutes.delete(node.route);
        RED._langchainApiRoutes.delete(node.route + '/events');
      }
    });
  }

  RED.nodes.registerType('langchain-agent-api', AgentApiNode);
};