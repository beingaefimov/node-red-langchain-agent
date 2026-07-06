import { DynamicTool } from '@langchain/core/tools';

export default function (RED) {
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

    // Expose getTool for agent-api to call directly
    node.getTool = () => buildTool();

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