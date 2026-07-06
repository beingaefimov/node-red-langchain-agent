// LangChain v1 uses LangGraph checkpointers for memory.
// This node now acts as a configuration node that ensures sessionId
// is properly set for the agent to use the checkpointer.
export default function (RED) {
  function MemoryBufferNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.memoryKey = config.memoryKey || 'chat_history';
    node.maxMessages = parseInt(config.maxMessages || '20', 10);
    node.useContext = config.useContext !== false && config.useContext !== 'false';

    node.on('input', function (msg, send, done) {
      try {
        msg.langchain = msg.langchain || {};
        // Pass session ID to the agent via msg.langchain
        const sessionId = msg.sessionId || (msg.payload && msg.payload.sessionId) || 'default';
        msg.langchain.sessionId = sessionId;
        
        // Note: In LangChain v1, the sliding window and history management
        // is handled by the LangGraph MemorySaver checkpointer in agent-api/agent
        send(msg);
        done && done();
      } catch (err) {
        done && done(err);
      }
    });
  }

  RED.nodes.registerType('langchain-memory-buffer', MemoryBufferNode);
};