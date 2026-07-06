'use strict';

const { AgentExecutor, createToolCallingAgent } = require('langchain/agents');
const {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  SystemMessagePromptTemplate,
  MessagesPlaceholder
} = require('@langchain/core/prompts');
const { BufferMemory, ChatMessageHistory } = require('langchain/memory');
const { randomUUID } = require('crypto');

const DEFAULT_REACT_TEMPLATE = `Answer the following questions as best you can. You have access to the following tools:

{tools}

Use the following format:

Question: the input question you must answer
Thought: you should always think about what to do
Action: the action to take, should be one of [{tool_names}]
Action Input: the input to the action
Observation: the result of the action
... (this Thought/Action/Action Input/Observation can repeat N times)
Thought: I now know the final answer
Final Answer: the final answer to the original input question

Begin!

Question: {input}
Thought:`;

// `langchain-agent-api` — config node that registers an async HTTP endpoint
// under the configured route. Two response modes:
//   - JSON     (default):  one final JSON object with {output, intermediateSteps, …}
//   - SSE      (stream):   text/event-stream with typed events:
//                           event: token       data: {delta: "..."}        - final-answer tokens
//                           event: tool_call   data: {tool, input}         - ReAct step
//                           event: tool_result data: {tool, output}        - ReAct step
//                           event: step        data: {n, label}            - coarse checkpoint
//                           event: final       data: {output, steps, ms}   - end of run
//                           event: error       data: {message}             - terminal error
// Set `stream: true` in the POST body to opt in.
// As a config node it has no inputs/outputs and stores the route + tool
// wiring in the flow. Other nodes reference it via the typed `defaults` of
// their own fields (see `langchain-agent` -> `agentApi`)
module.exports = function (RED) {
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

    function buildExecutor(req, sessionId) {
      const llmNode = RED.nodes.getNode(node.llmNode);
      if (!llmNode) throw new Error('agent-api: llmNode not configured');
      // `getLlm` may be async if it pulls OAuth2 bearer
      return Promise.resolve(llmNode.getLlm(req.body || {})).then((llm) => {
        const tools = [];
        for (const id of node.toolNodes) {
          const tNode = RED.nodes.getNode(id);
          if (!tNode) continue;
          if (typeof tNode.getTool === 'function') {
            tools.push(tNode.getTool());
          }
        }

        const prompt = ChatPromptTemplate.fromMessages([
          SystemMessagePromptTemplate.fromTemplate(node.systemMessage),
          new MessagesPlaceholder({ variableName: 'chat_history', optional: true }),
          HumanMessagePromptTemplate.fromTemplate('{input}'),
          new MessagesPlaceholder({ variableName: 'agent_scratchpad', optional: true })
        ]);

        let memory;
        if (sessionId) {
          const history = node.context().global.get(`langchain_mem_${sessionId}`) || new ChatMessageHistory();
          node.context().global.set(`langchain_mem_${sessionId}`, history);
          memory = new BufferMemory({ 
            chatHistory: history, 
            returnMessages: true, 
            memoryKey: 'chat_history',
            inputKey: 'input',
            outputKey: 'output'
          });
        }

        const agent = createToolCallingAgent({ llm, tools, prompt });
        return new AgentExecutor({
          agent,
          tools,
          memory,
          maxIterations: node.maxIterations,
          maxExecutionTime: node.maxExecutionTime,
          returnIntermediateSteps: node.returnIntermediateSteps || true,
          handleParsingErrors: true,
        });
      });
    }

    /** Single source of truth: `executor.streamEvents({input, version: 'v1'})`.
     * Yields the full event surface of the ReAct loop without re-invoking
     * the LLM */
    async function streamExecutor(executor, input, res, requestId) {
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
        const eventStream = await executor.streamEvents({ input, version: 'v1' });
        for await (const ev of eventStream) {
          if (aborted) break;

          if (ev.event === 'on_llm_stream') {
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
            const text = typeof out === 'string'
              ? out
              : (out && out.toString ? out.toString() : JSON.stringify(out));
            sseEvent('tool_result', { step: stepN, tool: ev.name, output: text });
            steps.push({ type: 'tool_result', tool: ev.name, output: text });
          } else if (ev.event === 'on_chain_end' && ev.name === 'AgentExecutor') {
            break;
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
      }
    }

    // Mount the HTTP route exactly once. Multiple `langchain-agent-api`
    // config nodes register additional routes; we track them in a Set
    // SSE mode
    if (!RED._langchainApiMounted) {
      RED.httpNode.post('/langchain-agent/ping', (_req, res) => {
        res.json({ ok: true, name: 'node-red-contrib-langchain-agent', version: '0.1.0' });
      });
      RED._langchainApiMounted = true;
    }
    if (!RED._langchainApiRoutes) RED._langchainApiRoutes = new Set();
    if (RED._langchainApiRoutes.has(node.route)) {
      // duplicate route - refuse to mount to avoid double-handling
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
          res.status(401).json({ error: 'unauthorized', requestId });
          return;
        }

        if (!input) {
          res.status(400).json({ error: 'input is required', requestId });
          return;
        }

        if (!stream) {
          try {
            const executor = await buildExecutor(req, sessionId);
            setImmediate(async () => {
              const started = Date.now();
              node.status({ text: 'reasoning...', fill: 'yellow', shape: 'ring' });
              try {
                const result = await executor.invoke({ input });
                node.status({ text: `done in ${((Date.now() - started) / 1000).toFixed(1)}s`, fill: 'green', shape: 'dot' });
                res.json({
                  requestId,
                  input: result.input,
                  output: result.output,
                  intermediateSteps: node.returnIntermediateSteps ? result.intermediateSteps : undefined,
                  durationMs: Date.now() - started,
                });
              } catch (err) {
                node.status({ text: 'error', fill: 'red', shape: 'dot' });
                node.error(err);
                res.status(500).json({ requestId, error: err.message });
              }
            });
          } catch (err) {
            res.status(500).json({ requestId, error: err.message });
          }
          return;
        }
        // SSE mode
        try {
          const executor = await buildExecutor(req, sessionId);
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders && res.flushHeaders();
          node.status({ text: 'streaming...', fill: 'yellow', shape: 'ring' });
          setImmediate(() => streamExecutor(executor, input, res, requestId).then(() => {
            node.status({ text: 'streamed', fill: 'green', shape: 'dot' });
          }));
        } catch (err) {
          res.status(500).json({ requestId, error: err.message });
        }
      });
    }

    
    // Optional companion GET endpoint for keep-alive / health checks
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

  // Config node: no inputs/outputs, palette category is `config` for
  // visibility in the standard tab, but visually distinguishable via
  // icon/color in the flow
  RED.nodes.registerType('langchain-agent-api', AgentApiNode);
};