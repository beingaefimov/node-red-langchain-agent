'use strict';

const { ChatOpenAI } = require('@langchain/openai');
const { ChatAnthropic } = require('@langchain/anthropic');

module.exports = function (RED) {
  function ChatModelNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.configNode = config.configNode;
    node.modelOverride = config.model;
    node.temperatureOverride = config.temperature;

    node.getLlm = async function (msg) {
      const cfg = RED.nodes.getNode(node.configNode);
      if (!cfg) {
        throw new Error('langchain-chat-model: missing langchain-config');
      }
      const model = node.modelOverride || cfg.model || 'gpt-4o-mini';
      const temperature = parseFloat(node.temperatureOverride ?? cfg.temperature ?? '0');
      const baseUrl = cfg.baseUrl;

      let apiKey;
      if (typeof RED._langchainGetBearer === 'function') {
        apiKey = await RED._langchainGetBearer(cfg);
      }
      if (!apiKey) {
        apiKey = cfg.credentials && cfg.credentials.apiKey;
      }
      if (!apiKey) {
        throw new Error('langchain-chat-model: no credentials — set API key or complete OAuth2');
      }

      if (cfg.provider === 'anthropic') {
        return new ChatAnthropic({
          apiKey,
          anthropicApiKey: apiKey,
          model: node.modelOverride || cfg.model || 'claude-3-5-sonnet-latest',
          temperature,
        });
      }
      
      const opts = { 
        apiKey, 
        openAIApiKey: apiKey, 
        model, 
        temperature 
      };
      if (baseUrl) opts.configuration = { baseURL: baseUrl };
      return new ChatOpenAI(opts);
    };

    node.on('input', function (msg, send, done) {
      (async () => {
        try {
          msg.langchain = msg.langchain || {};
          msg.langchain.llm = await node.getLlm(msg);
          send(msg);
          done && done();
        } catch (err) {
          done && done(err);
        }
      })();
    });
  }

  RED.nodes.registerType('langchain-chat-model', ChatModelNode);
};