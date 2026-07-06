'use strict';

const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');

// RAG tool backed by a JSON-lines corpus in node.context(). Lazily embeds
// nothing - vector search is by simple cosine of OpenAI embeddings cached on
// the corpus. Keeps zero extra deps; users can replace this file with a
// real vector store (Chroma, Pinecone, ...) by editing the class
class InMemoryVectorStore {
  constructor(docs) {
    this.docs = docs; // [{ text, embedding }]
  }
  static async fromTexts(texts, embed) {
    const vecs = await embed.embedDocuments(texts);
    return new InMemoryVectorStore(texts.map((text, i) => ({ text, embedding: vecs[i] })));
  }
  async similaritySearch(query, k = 3, embed) {
    const q = (await embed.embedQuery(query))[0];
    const scored = this.docs.map((d) => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < q.length; i++) {
        dot += q[i] * d.embedding[i];
        na += q[i] * q[i];
        nb += d.embedding[i] * d.embedding[i];
      }
      return { d, s: dot / (Math.sqrt(na) * Math.sqrt(nb) || 1) };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, k).map((x) => x.d.text);
  }
}

const { DynamicTool } = require('@langchain/core/tools');

module.exports = function (RED) {
  function VectorStoreNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.collection = config.collection || 'default';
    node.chunkSize = parseInt(config.chunkSize || '1000', 10);
    node.chunkOverlap = parseInt(config.chunkOverlap || '200', 10);
    node.k = parseInt(config.k || '4', 10);
    node.llmNode = config.llmNode;

    async function buildStore(embedModel) {
      const raw = node.context().global.get(`langchain_vs_${node.collection}`) || [];
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: node.chunkSize,
        chunkOverlap: node.chunkOverlap,
      });
      const chunks = [];
      for (const doc of raw) {
        const parts = await splitter.splitText(typeof doc === 'string' ? doc : doc.text);
        chunks.push(...parts);
      }
      return InMemoryVectorStore.fromTexts(chunks, embedModel);
    }

    node.on('input', async function (msg, send, done) {
      try {
        const cfg = RED.nodes.getNode(node.llmNode);
        if (!cfg) throw new Error('langchain-vectorstore: missing llmNode');
        const llm = RED.nodes.getNode(node.llmNode) && RED.nodes.getNode(node.llmNode).getLlm
          ? RED.nodes.getNode(node.llmNode).getLlm(msg)
          : msg.langchain && msg.langchain.llm;
        if (!llm) throw new Error('langchain-vectorstore: no embedding-capable model attached');

        const action = msg.payload && msg.payload.action;
        if (action === 'add') {
          const raw = node.context().global.get(`langchain_vs_${node.collection}`) || [];
          const docs = Array.isArray(msg.payload.documents) ? msg.payload.documents : [msg.payload.document || msg.payload.text];
          node.context().global.set(`langchain_vs_${node.collection}`, raw.concat(docs.filter(Boolean)));
          msg.payload = { ok: true, added: docs.length };
          send(msg); done && done(); return;
        }

        // default: expose as a retriever tool
        const store = await buildStore(llm);
        const tool = new DynamicTool({
          name: `${node.collection}_search`,
          description: `Look up relevant documents in the "${node.collection}" knowledge base. Use this whenever the question is about stored information.`,
          func: async (q) => {
            const hits = await store.similaritySearch(q, node.k, llm);
            return hits.join('\n\n---\n\n');
          },
        });
        // also expose via getTool() for direct lookup from agent-api
        node.getTool = () => tool;
        msg.langchain = msg.langchain || {};
        msg.langchain.tools = msg.langchain.tools || [];
        msg.langchain.tools.push(tool);
        send(msg); done && done();
      } catch (err) {
        done && done(err);
      }
    });
  }

  RED.nodes.registerType('langchain-vectorstore', VectorStoreNode);
};
