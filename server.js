const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Routes Puppeteer traffic through ScraperAPI's proxy pool as a fallback
// when a direct request is blocked by the target site's bot protection.
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || '';
const USE_PROXY = Boolean(SCRAPERAPI_KEY);
const PROXY_SERVER = 'proxy-server.scraperapi.com';
const PROXY_PORT = '8001';

// executablePath is set to PUPPETEER_EXECUTABLE_PATH in the Docker image
// (apt-installed Chromium); undefined locally, where Puppeteer resolves
// its own browser.
const LAUNCH_OPTIONS = (useProxy) => ({
  headless: 'new',
  acceptInsecureCerts: useProxy, // accepts the proxy's TLS certificate
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    ...(useProxy ? [`--proxy-server=http://${PROXY_SERVER}:${PROXY_PORT}`, '--ignore-certificate-errors'] : []),
  ],
});

async function preparePage(page, useProxy) {
  if (useProxy) {
    await page.authenticate({ username: 'scraperapi', password: SCRAPERAPI_KEY });
  }
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const blocked = ['image', 'font', 'media', 'stylesheet'];
    if (blocked.includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchChatGPT(url, useProxy) {
  const browser = await puppeteer.launch(LAUNCH_OPTIONS(useProxy));
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await preparePage(page, useProxy);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: useProxy ? 45000 : 20000 });

    // Direct attempts use a short timeout; proxied attempts use the full budget.
    try {
      await page.waitForSelector('[data-message-author-role]', { timeout: useProxy ? 30000 : 12000 });
    } catch {
      await new Promise(r => setTimeout(r, useProxy ? 8000 : 3000));
    }

    const nextData = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch { return null; }
    });

    const html = await page.content();

    const domTurns = await page.evaluate(() => {
      const nodes = document.querySelectorAll('[data-message-author-role]');
      const turns = [];
      nodes.forEach(node => {
        const text = node.innerText?.trim();
        if (text) turns.push(text);
      });
      return turns;
    });

    console.log('[ChatGPT] page title:', await page.title());
    console.log('[ChatGPT] __NEXT_DATA__ found:', Boolean(nextData));
    if (nextData) {
      console.log('[ChatGPT] __NEXT_DATA__ pageProps keys:', Object.keys(nextData?.props?.pageProps || {}));
    }
    console.log('[ChatGPT] DOM selector hits:', domTurns.length);
    if (!nextData && domTurns.length === 0) {
      console.log('[ChatGPT] HTML snippet:', html.slice(0, 500));
    }

    return { html, nextData, domTurns };
  } finally {
    await browser.close();
  }
}

async function fetchClaude(url, useProxy) {
  const browser = await puppeteer.launch(LAUNCH_OPTIONS(useProxy));
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await preparePage(page, useProxy);

    // The response listener must be registered before navigation starts,
    // otherwise the target response may be missed.
    const isConversationResponse = (res) => {
      const u = res.url();
      return (
        u.includes('/api/chat_snapshots/') ||
        u.includes('/api/share/') ||
        (u.includes('/share/') && u.includes('conversation'))
      );
    };

    const [conversationResponse] = await Promise.all([
      page.waitForResponse(isConversationResponse, { timeout: useProxy ? 45000 : 15000 }),
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: useProxy ? 45000 : 20000 }),
    ]);

    const conversationData = await conversationResponse.json();
    return conversationData;
  } finally {
    await browser.close();
  }
}

function extractPartsText(parts) {
  return (parts || []).map(p => {
    if (typeof p === 'string') return p;
    if (p?.content_type === 'text' && p?.text) return p.text;
    if (p?.content_type === 'code' && p?.text) return '```\n' + p.text + '\n```';
    return '';
  }).filter(Boolean).join('\n').trim();
}

function parseChatGPT({ html, nextData, domTurns }, url) {
  if (nextData) {
    // Checks each known location for the message tree in the payload.
    const data =
      nextData?.props?.pageProps?.serverResponse?.data ||
      nextData?.props?.pageProps?.data ||
      nextData?.props?.pageProps;

    const mapping = data?.mapping;
    if (mapping) {
      const { title } = data;
      const nodes = Object.values(mapping);
      const rootNode = nodes.find(n => !n.parent || !mapping[n.parent]);
      if (rootNode) {
        const turns = [];
        const walk = (nodeId) => {
          const node = mapping[nodeId];
          if (!node) return;
          const msg = node.message;
          if (msg?.author && msg?.content) {
            const role = msg.author.role;
            if (role !== 'system' && role !== 'tool') {
              let text = extractPartsText(msg.content.parts);
              if (!text && typeof msg.content.text === 'string') text = msg.content.text.trim();
              if (text) turns.push(text);
            }
          }
          if (node.children?.length > 0) walk(node.children[node.children.length - 1]);
        };
        walk(rootNode.id);
        if (turns.length > 0) return { title: title || 'ChatGPT Conversation', turns, url };
      }
    }
  }

  if (domTurns && domTurns.length > 0) {
    console.log(`[ChatGPT] __NEXT_DATA__ parse failed; using DOM fallback (${domTurns.length} turns)`);
    return { title: 'ChatGPT Conversation', turns: domTurns, url };
  }

  throw new Error('Could not extract ChatGPT conversation. The link may be private or expired.');
}

function parseClaude(data, url) {
  if (!data) throw new Error('No data intercepted from Claude. The link may be private, expired, or the page structure changed.');

  const conversation = data?.conversation || data;
  const rawMessages = conversation?.chat_messages || conversation?.messages || [];

  if (rawMessages.length === 0) throw new Error('Conversation found but contains no messages.');

  if (rawMessages[0]) console.log('[Claude] First message keys:', Object.keys(rawMessages[0]));

  const turns = [];
  for (const msg of rawMessages) {
    let text = '';

    if (Array.isArray(msg.content) && msg.content.length > 0) {
      text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    }

    if (!text && typeof msg.content === 'string') {
      text = msg.content.trim();
    }

    if (!text && typeof msg.text === 'string') {
      console.warn('[Claude] Using msg.text fallback for a message — content blocks were empty.');
      text = msg.text.trim();
    }

    if (text) turns.push(text);
  }

  if (turns.length === 0) {
    console.error('[Claude] All messages had empty content. First raw message:', JSON.stringify(rawMessages[0]).slice(0, 500));
    throw new Error('No text content found in conversation. The message format may have changed.');
  }

  const title = conversation?.name || conversation?.title || 'Claude Conversation';
  return { title, turns, url };
}

function buildMarkdown({ title, turns, url }) {
  const date = new Date().toISOString().split('T')[0];
  const DIVIDER = '='.repeat(40);
  const lines = [`# ${title}`, '', `> Extracted from: ${url}`, `> Date: ${date}`, ''];
  for (const text of turns) {
    lines.push(DIVIDER, '', text, '');
  }
  return lines.join('\n');
}

async function getChatGPT(url, useProxy) {
  const data = await fetchChatGPT(url, useProxy);
  return parseChatGPT(data, url);
}

async function getClaude(url, useProxy) {
  const data = await fetchClaude(url, useProxy);
  return parseClaude(data, url);
}

// Attempts a direct request first; retries through the proxy only if the
// direct attempt fails and a proxy key is configured.
async function extractWithProxyFallback(fn) {
  try {
    return await fn(false);
  } catch (err) {
    if (!USE_PROXY) throw err;
    console.log('Direct attempt failed, retrying via proxy:', err.message);
    return await fn(true);
  }
}

app.post('/extract', async (req, res) => {
  const { url, bot } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  if (!['chatgpt', 'claude'].includes(bot)) return res.status(400).json({ error: 'bot must be "chatgpt" or "claude".' });

  const validDomain = bot === 'chatgpt' ? 'chatgpt.com/share' : 'claude.ai/share';
  if (!url.includes(validDomain)) {
    return res.status(400).json({ error: `URL doesn't look like a ${bot === 'chatgpt' ? 'ChatGPT' : 'Claude'} share link. Expected: ${validDomain}` });
  }

  try {
    if (bot === 'chatgpt') {
      const result = await extractWithProxyFallback((useProxy) => getChatGPT(url, useProxy));
      return res.json({ markdown: buildMarkdown(result) });
    } else {
      const result = await extractWithProxyFallback((useProxy) => getClaude(url, useProxy));
      return res.json({ markdown: buildMarkdown(result) });
    }
  } catch (err) {
    console.error('Extraction error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Diagnostic endpoint returning the raw shape of Claude's intercepted
// response, for use when parseClaude() requires debugging.
app.post('/debug-claude', async (req, res) => {
  const { url, useProxy = false } = req.body;
  const browser = await puppeteer.launch(LAUNCH_OPTIONS(useProxy && USE_PROXY));
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await preparePage(page, useProxy && USE_PROXY);

    const isConversationResponse = (r) =>
      r.url().includes('/api/chat_snapshots/') ||
      r.url().includes('/api/share/') ||
      (r.url().includes('/share/') && r.url().includes('conversation'));

    let captured = null;
    try {
      const [response] = await Promise.all([
        page.waitForResponse(isConversationResponse, { timeout: 45000 }),
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
      ]);
      captured = await response.json();
    } catch (e) {
      return res.json({ error: `Failed to intercept conversation response: ${e.message}` });
    }

    if (!captured) return res.json({ error: 'chat_snapshots not intercepted' });
    const conv = captured?.conversation || captured;
    const msgs = conv?.chat_messages || conv?.messages || [];
    return res.json({
      topKeys: Object.keys(captured),
      convKeys: Object.keys(conv),
      messageCount: msgs.length,
      firstMessageKeys: msgs[0] ? Object.keys(msgs[0]) : [],
      firstMessageSample: msgs[0] ? JSON.stringify(msgs[0]).slice(0, 500) : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

const server = app.listen(PORT, () => {
  console.log(`✓ Chat Extractor running at http://localhost:${PORT}`);
  console.log(USE_PROXY ? '✓ Proxy fallback: available (ScraperAPI, used only if direct attempts fail)' : '⚠ Proxy fallback: OFF (no SCRAPERAPI_KEY set — all requests go out on this host\'s raw IP)');
});

// The worst case is a failed direct attempt followed by a full proxied
// retry, sequentially; 180s provides headroom under Render's reverse-proxy
// cutoff.
server.keepAliveTimeout = 180000;
server.headersTimeout = 180000;