import { createAgent } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';

const memoryCheckpointer = new MemorySaver();

const DEFAULT_SYSTEM_MESSAGE = 'You are a helpful AI assistant. Think step by step and use tools when they help answer the question accurately.';

function getNodeConfig(node) {
  return {
    systemMessage: node.systemMessage || DEFAULT_SYSTEM_MESSAGE,
    humanMessage: node.humanMessage || '{input}',
    maxIterations: Number.isFinite(parseInt(node.maxIterations, 10)) ? parseInt(node.maxIterations, 10) : 10,
    returnIntermediateSteps: node.returnIntermediateSteps === true || node.returnIntermediateSteps === 'true',
    handleParsingErrors: node.handleParsingErrors !== false && node.handleParsingErrors !== 'false',
    verbose: node.verbose === true || node.verbose === 'true',
    maxExecutionTime: Number.isFinite(parseInt(node.maxExecutionTime, 10)) ? parseInt(node.maxExecutionTime, 10) : 120,
  };
}

function resolveLlmSubnode(RED, node, msg) {
  if (node.modelNode) {
    const sub = RED.nodes.getNode(node.modelNode);
    if (sub && typeof sub.getLlm === 'function') return sub.getLlm(msg);
  }
  if (msg && msg.langchain && msg.langchain.llm) return msg.langchain.llm;
  return null;
}

function resolveTools(node, msg) {
  const tools = [];
  if (Array.isArray(msg && msg.langchain && msg.langchain.tools)) {
    tools.push(...msg.langchain.tools);
  }
  return tools;
}

function inputTextFromMsg(msg) {
  if (typeof msg.payload === 'string') return msg.payload;
  if (msg.payload && typeof msg.payload.input === 'string') return msg.payload.input;
  if (msg.payload && typeof msg.payload.question === 'string') return msg.payload.question;
  if (msg.payload && typeof msg.payload.text === 'string') return msg.payload.text;
  if (typeof msg.topic === 'string' && msg.topic) return msg.topic;
  return JSON.stringify(msg.payload);
}

async function runAgent(RED, node, msg) {
  if (node.agentApi) {
    const apiNode = RED.nodes.getNode(node.agentApi);
    if (!apiNode) throw new Error('langchain-agent: bound agent-api config node is missing');
    const route = apiNode.route || '/agent/run';
    const body = JSON.stringify({
      input: inputTextFromMsg(msg),
      sessionId: msg.sessionId || (msg.payload && msg.payload.sessionId),
      stream: false,
    });
    const res = await fetch('http://127.0.0.1:' + (RED.settings && RED.settings.uiPort || 1880) + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('agent-api responded ' + res.status + ': ' + t);
    }
    return res.json();
  }

  const cfg = getNodeConfig(node);
  const llm = await resolveLlmSubnode(RED, node, msg);
  if (!llm) throw new Error('No chat model configured. Wire a "langchain-chat-model" config or attach msg.langchain.llm.');
  
  const tools = resolveTools(node, msg);
  if (tools.length === 0) node.warn('Agent is running with zero tools — the LLM will answer from its own knowledge only.');
  
  const sessionId = (msg.langchain && msg.langchain.sessionId) || msg.sessionId || 'default';

  const agent = createAgent({
    model: llm,
    tools,
    systemPrompt: cfg.systemMessage,
    checkpointer: memoryCheckpointer
  });

  const input = inputTextFromMsg(msg);
  const config = {
    configurable: { thread_id: sessionId },
    recursion_limit: cfg.maxIterations + 1,
    timeout: cfg.maxExecutionTime * 1000
  };

  const result = await agent.invoke(
    { messages: [{ role: 'user', content: input }] },
    config
  );

  const lastMsg = result.messages[result.messages.length - 1];
  const outputText = typeof lastMsg.content === 'string' 
    ? lastMsg.content 
    : JSON.stringify(lastMsg.content);

  return {
    input,
    output: outputText,
    intermediateSteps: result.messages
  };
}

export default function (RED) {
  function LangChainAgentNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.systemMessage = config.systemMessage;
    node.humanMessage = config.humanMessage;
    node.maxIterations = config.maxIterations;
    node.maxExecutionTime = config.maxExecutionTime;
    node.returnIntermediateSteps = config.returnIntermediateSteps;
    node.handleParsingErrors = config.handleParsingErrors;
    node.verbose = config.verbose;
    node.modelNode = config.modelNode;
    node.toolNodes = config.toolNodes;
    node.agentApi = config.agentApi;

    node.on('input', async function (msg, _send, done) {
      const started = Date.now();
      node.status({ text: 'reasoning...', fill: 'yellow', shape: 'ring' });
      try {
        const result = await runAgent(RED, node, msg);
        msg.payload = {
          input: result.input,
          output: result.output,
          intermediateSteps: (node.returnIntermediateSteps === true || node.returnIntermediateSteps === 'true')
            ? result.intermediateSteps || []
            : undefined,
        };
        if (result.intermediateSteps && (node.returnIntermediateSteps === true || node.returnIntermediateSteps === 'true')) {
          msg.langchain = msg.langchain || {};
          msg.langchain.intermediateSteps = result.intermediateSteps;
        }
        node.status({ text: `done in ${((Date.now() - started) / 1000).toFixed(1)}s`, fill: 'green', shape: 'dot' });
        node.send(msg);
        done && done();
      } catch (err) {
        node.status({ text: 'error', fill: 'red', shape: 'dot' });
        node.error(err, msg);
        done && done(err);
      }
    });

    node.on('close', function () { node.status({}); });
  }

  RED.nodes.registerType('langchain-agent', LangChainAgentNode);
};