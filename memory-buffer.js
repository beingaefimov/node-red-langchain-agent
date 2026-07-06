'use strict';

const { BufferMemory, ChatMessageHistory } = require('langchain/memory');

// Conversation-memory sub-node. Each msg.sessionId gets its own memory slot
// in RED.context. Pass-through - the agent picks it up via msg.langchain.memory
module.exports = function (RED) {
  function MemoryBufferNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.memoryKey = config.memoryKey || 'chat_history';
    node.humanPrefix = config.humanPrefix || 'Human';
    node.aiPrefix = config.aiPrefix || 'AI';
    node.maxMessages = parseInt(config.maxMessages || '20', 10);
    node.useContext = config.useContext !== false && config.useContext !== 'false';

    function getMemory(sessionId) {
      const key = `langchain_mem_${sessionId || 'default'}`;
      const ctxKey = node.useContext ? RED.util.evaluateNodeProperty(node.memoryKey, 'str', node, {}) : key;
      const store = node.useContext ? node.context().global : node.context().flow;
      let history = store.get(key);
      if (!history) {
        history = new ChatMessageHistory();
        store.set(key, history);
      }
      return new BufferMemory({
        chatHistory: history,
        memoryKey: ctxKey,
        humanPrefix: node.humanPrefix,
        aiPrefix: node.aiPrefix,
        returnMessages: true,
        maxMsgCount: node.maxMessages,
        inputKey: 'input',
        outputKey: 'output'
      });
    }

    node.on('input', function (msg, send, done) {
      try {
        msg.langchain = msg.langchain || {};
        msg.langchain.memory = getMemory(msg.sessionId || msg.payload && msg.payload.sessionId);
        send(msg);
        done && done();
      } catch (err) {
        done && done(err);
      }
    });
  }

  RED.nodes.registerType('langchain-memory-buffer', MemoryBufferNode);
};