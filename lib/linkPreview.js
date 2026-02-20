const https = require('https');
const http = require('http');
const { URL } = require('url');
const { escapeHtml } = require('./utils');

const previewCache = new Map();

async function fetchLinkPreview(rawUrl) {
  if (previewCache.has(rawUrl)) return previewCache.get(rawUrl);
  return new Promise((resolve) => {
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) { resolve(null); return; }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(rawUrl, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0 (chatroom-preview)' } }, (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        let body = '';
        res.on('data', (chunk) => { body += chunk; if (body.length > 50000) req.destroy(); });
        res.on('end', () => {
          const getMeta = (prop) => {
            const m = body.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
                     || body.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
            return m ? escapeHtml(m[1].slice(0, 200)) : null;
          };
          const titleM = body.match(/<title[^>]*>([^<]+)<\/title>/i);
          const result = {
            title: getMeta('og:title') || (titleM ? escapeHtml(titleM[1].slice(0, 100)) : null),
            image: getMeta('og:image'),
            description: getMeta('og:description') || getMeta('description'),
          };
          if (result.title || result.description) { previewCache.set(rawUrl, result); resolve(result); }
          else resolve(null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

module.exports = { fetchLinkPreview };