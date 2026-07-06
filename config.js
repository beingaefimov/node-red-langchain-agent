'use strict';

const crypto = require('crypto');

// Map of OAuth2 providers we know how to talk to. Each entry knows its
// authorization URL, token URL, and the scopes required to call the chat
// completions API
const OAUTH2_PROVIDERS = {
  'openai-oauth': {
    label: 'OpenAI (OAuth2, generic)',
    authorizationUrl: 'https://platform.openai.com/oauth/authorize',
    tokenUrl: 'https://api.openai.com/oauth/token',
    revokeUrl: 'https://api.openai.com/oauth/revoke',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
  },
  'anthropic-oauth': {
    label: 'Anthropic (OAuth2, generic)',
    authorizationUrl: 'https://console.anthropic.com/oauth/authorize',
    tokenUrl: 'https://api.anthropic.com/oauth/token',
    scopes: ['user:profile', 'user:inference'],
  },
};

// Configuration node that holds an LLM provider. Multiple chat-model config
// nodes can be created (one per provider / key) and the agent picks one via
// modelNode. Supports two auth modes:
//   - apiKey:  the legacy `apiKey` password credential
//   - oauth2:  an OAuth2 flow (provider-specific) granting bearer tokens
module.exports = function (RED) {
  // In-memory state store for OAuth2 state tokens. We don't persist these -
  // if Node-RED restarts during an in-flight flow the user just retries.
  // Periodic GC evicts entries older than 10 minutes to bound memory
  const PENDING_TTL_MS = 10 * 60 * 1000;
  const pendingStates = new Map();
  const gc = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingStates) {
      if (now - v.ts > PENDING_TTL_MS) pendingStates.delete(k);
    }
  }, 60 * 1000);
  // Don't keep the Node-RED event loop alive just for GC.
  if (gc.unref) gc.unref();

  // PKCE helpers (RFC 7636).
  // code_verifier - 43..128 chars of [A-Z][a-z][0-9]-._~ generated from
  //                  32 random bytes. base64url-encoded without padding.
  // code_challenge - SHA-256(code_verifier), then base64url-encoded.
  // code_challenge_method - "S256".
  // We do NOT support the "plain" method on purpose - S256 is the secure
  // default, and providers that accept "plain" also accept "S256"
  function base64url(buf) {
    return Buffer.from(buf).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function newCodeVerifier() {
    return base64url(crypto.randomBytes(32));
  }
  function codeChallengeFor(verifier) {
    return base64url(crypto.createHash('sha256').update(verifier).digest());
  }
  function randomState() {
    return crypto.randomBytes(24).toString('hex');
  }

  function registerHttp() {
    if (RED._langchainOauthMounted) return;
    RED._langchainOauthMounted = true;

    // GET /langchain-agent/oauth/:nodeId/start
    //   kicks off the OAuth2 flow. The actual `nodeId` here is the
    //   langchain-config node id the user wants to authorize.
    // We always use PKCE (S256). code_verifier is generated here, the
    // matching code_challenge is sent to the provider, and code_verifier
    // is stashed in `pendingStates` so /callback can send it on the
    // token-exchange request
    RED.httpAdmin.get('/langchain-agent/oauth/:nodeId/start', (req, res) => {
      const nodeId = req.params.nodeId;
      const configNode = RED.nodes.getNode(nodeId);
      if (!configNode || configNode.type !== 'langchain-config') {
        return res.status(404).json({ error: 'config node not found' });
      }
      const provider = OAUTH2_PROVIDERS[configNode.oauth2Provider];
      if (!provider) {
        return res.status(400).json({ error: 'no OAuth2 provider configured on this node' });
      }
      if (!configNode.oauth2ClientId) {
        return res.status(400).json({ error: 'OAuth2 clientId missing' });
      }
      const state = randomState();
      const codeVerifier = newCodeVerifier();
      const codeChallenge = codeChallengeFor(codeVerifier);
      pendingStates.set(state, { nodeId, codeVerifier, ts: Date.now() });

      const redirectUri = configNode.oauth2RedirectUri
        || `${req.protocol}://${req.get('host')}/langchain-agent/oauth/${nodeId}/callback`;

      const url = new URL(provider.authorizationUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', configNode.oauth2ClientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', (provider.scopes || []).join(' '));
      url.searchParams.set('state', state);
      // PKCE - RFC 7636
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      res.json({ redirectUrl: url.toString(), state });
    });

    // GET /langchain-agent/oauth/:nodeId/callback
    //   code -> access_token exchange. Returns a tiny HTML page that closes
    //   the popup and notifies the parent window
    RED.httpAdmin.get('/langchain-agent/oauth/:nodeId/callback', async (req, res) => {
      const nodeId = req.params.nodeId;
      const { code, state, error } = req.query;
      const pending = state && pendingStates.get(String(state));
      if (!pending || pending.nodeId !== nodeId) {
        res.status(400).send('<h1>OAuth2 state mismatch</h1>');
        return;
      }
      // Consume the pending entry, code_verifier is single-use.
      const codeVerifier = pending.codeVerifier;
      pendingStates.delete(String(state));
      if (error) {
        res.status(400).send(`<h1>OAuth2 error: ${error}</h1>`);
        return;
      }
      const configNode = RED.nodes.getNode(nodeId);
      if (!configNode) {
        res.status(404).send('<h1>config node missing</h1>');
        return;
      }
      const provider = OAUTH2_PROVIDERS[configNode.oauth2Provider];
      if (!provider) {
        res.status(400).send('<h1>no provider</h1>');
        return;
      }
      try {
        const redirectUri = configNode.oauth2RedirectUri
          || `${req.protocol}://${req.get('host')}/langchain-agent/oauth/${nodeId}/callback`;
        const bodyParams = {
          grant_type: 'authorization_code',
          code: String(code),
          client_id: configNode.oauth2ClientId,
          client_secret: configNode.oauth2ClientSecret || '',
          redirect_uri: redirectUri,
        };
        if (codeVerifier) {
          // RFC 7636 - finish the PKCE exchange. Some public-client OAuth2
          // providers REQUIRE this; confidential ones accept it as a second
          // factor. Always include when we have a verifier
          bodyParams.code_verifier = codeVerifier;
        }
        const tokenRes = await fetch(provider.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
          body: new URLSearchParams(bodyParams).toString(),
        });
        const tokenJson = await tokenRes.json();
        if (!tokenRes.ok) {
          res.status(500).send(`<h1>token exchange failed</h1><pre>${JSON.stringify(tokenJson, null, 2)}</pre>`);
          return;
        }
        // Stash the tokens on the config node. In a real package you'd encrypt
        // this; for the contrib sample we keep them in memory and accept the
        // trade-off
        configNode._oauth2 = {
          accessToken: tokenJson.access_token,
          refreshToken: tokenJson.refresh_token,
          expiresAt: Date.now() + ((tokenJson.expires_in || 3600) * 1000),
          scope: tokenJson.scope,
          tokenType: tokenJson.token_type || 'Bearer',
        };
        configNode.dirty = true;
        // Tiny HTML page that closes the popup. The editor listens on
        // window.message for type=oauthComplete to refresh credentials UI
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!doctype html>
<html><body><script>
window.opener && window.opener.postMessage({type:'oauthComplete', nodeId:'${nodeId}'}, '*');
window.close();
</script><p>You can close this window.</p></body></html>`);
      } catch (e) {
        res.status(500).send(`<h1>exception</h1><pre>${e.message}</pre>`);
      }
    });

    // GET /langchain-agent/oauth/:nodeId/status
    // editor polls this to decide whether the "Authorize" button is shown
    RED.httpAdmin.get('/langchain-agent/oauth/:nodeId/status', (req, res) => {
      const nodeId = req.params.nodeId;
      const configNode = RED.nodes.getNode(nodeId);
      const t = configNode && configNode._oauth2;
      res.json({
        authorized: !!(t && t.accessToken),
        expiresAt: t ? t.expiresAt : 0,
        hasRefreshToken: !!(t && t.refreshToken),
      });
    });

    // GET /langchain-agent/oauth/providers
    // editor fetches the list of known OAuth2 providers
    RED.httpAdmin.get('/langchain-agent/oauth/providers', (_req, res) => {
      const out = {};
      for (const [k, v] of Object.entries(OAUTH2_PROVIDERS)) {
        out[k] = { label: v.label, authorizationUrl: v.authorizationUrl, scopes: v.scopes };
      }
      res.json(out);
    });
  }

  // Token refresh, call from the runtime before a request if expired.
  async function refreshIfNeeded(node) {
    const t = node._oauth2;
    if (!t || !t.refreshToken) return t;
    if (t.expiresAt - Date.now() > 30 * 1000) return t; // still valid
    const provider = OAUTH2_PROVIDERS[node.oauth2Provider];
    if (!provider) return t;
    const res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refreshToken,
        client_id: node.oauth2ClientId,
        client_secret: node.oauth2ClientSecret || '',
      }).toString(),
    });
    if (!res.ok) {
      // refresh failed; fall back to existing token; caller will get 401
      return t;
    }
    const j = await res.json();
    node._oauth2 = {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || t.refreshToken,
      expiresAt: Date.now() + ((j.expires_in || 3600) * 1000),
      scope: j.scope || t.scope,
      tokenType: j.token_type || t.tokenType,
    };
    node.dirty = true;
    return node._oauth2;
  }

  // Public: resolve the bearer token for a config node. Used by
  // llm-openai.js to construct the OpenAI/Anthropic client
  RED._langchainGetBearer = async function (node) {
    if (!node || !node.authType) return null;
    if (node.authType === 'apiKey') {
      return node.credentials && node.credentials.apiKey;
    }
    if (node.authType === 'oauth2') {
      const t = await refreshIfNeeded(node);
      return t && t.accessToken;
    }
    return null;
  };

  // Expose provider metadata to the editor (popup selector)
  RED._langchainOauthProviders = OAUTH2_PROVIDERS;

  // Config node class
  function LangChainConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.provider = config.provider || 'openai';
    node.model = config.model || 'gpt-4o-mini';
    node.temperature = config.temperature || '0';
    node.baseUrl = config.baseUrl;

    // OAuth2 fields
    node.authType = config.authType || 'apiKey'; // 'apiKey' | 'oauth2'
    node.oauth2Provider = config.oauth2Provider || '';
    node.oauth2ClientId = config.oauth2ClientId || '';
    node.oauth2ClientSecret = config.oauth2ClientSecret || '';
    node.oauth2RedirectUri = config.oauth2RedirectUri || '';

    registerHttp();
  }

  RED.nodes.registerType('langchain-config', LangChainConfigNode, {
    credentials: {
      apiKey: { type: 'password' },
      oauth2ClientSecret: { type: 'password' },
    },
  });
};
