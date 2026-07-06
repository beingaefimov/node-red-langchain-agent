'use strict';

const { DynamicTool } = require('@langchain/core/tools');

// Custom-function tool sub-node. The user pastes an async function body in the
// editor; we wrap it in a DynamicTool that the agent can invoke
module.exports = function (RED) {
  function ToolFunctionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.name = config.name;
    node.description = config.description;
    node.code = config.code;

    function buildTool() {
      const fn = new Function('input', `return (async () => { ${node.code} })();`);
      return new DynamicTool({
        name: node.name || 'tool',
        description: node.description || 'A custom tool',
        func: async (input) => {
          const result = await fn(typeof input === 'string' ? input : JSON.stringify(input));
          if (result && typeof result === 'object') return JSON.stringify(result);
          return String(result);
        },
      });
    }

    node.on('input', function (msg, send, done) {
      try {
        msg.langchain = msg.langchain || {};
        msg.langchain.tools = msg.langchain.tools || [];
        msg.langchain.tools.push(buildTool());
        send(msg);
        done && done();
      } catch (err) {
        done && done(err);
      }
    });
  }

  RED.nodes.registerType('langchain-tool-function', ToolFunctionNode);
};
