/*
 * Storage adapter for the Franco's Pickleball API.
 * Production: Netlify Blobs. Local/tests: in-memory or JSON-file adapter.
 * Select with PB_STORE = 'blobs' | 'file' | 'memory'.
 * Default: 'blobs' on the Netlify runtime, else 'file'.
 * The Blobs store is resolved fresh on EVERY operation, never cached:
 * @netlify/blobs captures the context token at getStore() time and its
 * Client then sends that token as a Bearer credential on every request.
 * The context Netlify injects for Functions v2 handlers is refreshed per
 * invocation and its token is short-lived, so a store cached in a warm
 * function instance keeps sending an expired token and every call fails
 * with "Netlify Blobs has generated an internal error (Failed to decode
 * token: Token expired)". Resolving per operation always picks up the
 * current invocation's fresh context.
 */
'use strict';

const mem = new Map();
let mode = process.env.PB_STORE || null;

async function getBlobs() {
  const { getStore } = require('@netlify/blobs');
  return getStore('francos-pickleball');
}

function filePath(key) {
  const fs = require('fs');
  const path = require('path');
  const dir = process.env.PB_DATA_DIR || '/tmp/francos-pickleball-data';
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
}

async function detectMode() {
  if (mode) return mode;
  // On Netlify (build/function runtime sets NETLIFY=true) Blobs is the store.
  // require.resolve checks are unreliable inside esbuild-bundled functions,
  // so select by environment, with PB_STORE as the explicit override.
  mode = (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) ? 'blobs' : 'file';
  return mode;
}

module.exports = {
  async get(key) {
    const m = await detectMode();
    if (m === 'memory') return mem.has(key) ? mem.get(key) : null;
    if (m === 'file') {
      const fs = require('fs');
      try { return JSON.parse(fs.readFileSync(filePath(key), 'utf8')); }
      catch (e) { return null; }
    }
    const store = await getBlobs();
    const val = await store.get(key, { type: 'json' });
    return val || null;
  },
  async set(key, value) {
    const m = await detectMode();
    if (m === 'memory') { mem.set(key, JSON.parse(JSON.stringify(value))); return; }
    if (m === 'file') {
      const fs = require('fs');
      fs.writeFileSync(filePath(key), JSON.stringify(value));
      return;
    }
    const store = await getBlobs();
    await store.setJSON(key, value);
  },
  _mode: detectMode
};
