const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─────────────────────────────────────────────
// ChatGPT: load page, extract __NEXT_DATA__ + HTML
// ─────────────────────────────────────────────
async function fetchChatGPT(url) {
  const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    try {
      await page.waitForSelector('[data-message-author-role]', { timeout: 10000 });
    } catch {
      await new Promise(r => setTimeout(r, 5000));
    }
    const nextData = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch { return null; }
    });
    const html = await page.content();
    return { html, nextData };
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// Claude: intercept /api/chat_snapshots/ response
// ─────────────────────────────────────────────
async function fetchClaude(url) {
  const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let conversationData = null;

    page.on('response', async (response) => {
      if (response.url().includes('/api/chat_snapshots/')) {
        try {
          const json = await response.json();
          if (json) conversationData = json;
        } catch {}
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 3000));
    return conversationData;
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// Extract text from a ChatGPT parts array
// Parts can be strings, text objects, or code objects
// ─────────────────────────────────────────────
function extractPartsText(parts) {
  return (parts || []).map(p => {
    if (typeof p === 'string') return p;
    if (p?.content_type === 'text' && p?.text) return p.text;
    if (p?.content_type === 'code' && p?.text) return '```\n' + p.text + '\n```';
    return '';
  }).filter(Boolean).join('\n').trim();
}

// ─────────────────────────────────────────────
// Parse ChatGPT — returns ordered list of turns (no role labels)
// ─────────────────────────────────────────────
function parseChatGPT({ html, nextData }, url) {
  if (nextData) {
    const data = nextData?.props?.pageProps?.serverResponse?.data;
    if (data?.mapping) {
      const { mapping, title } = data;
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

  // DOM fallback
  const turns = [];
  const regex = /data-message-author-role="(user|assistant)"[\s\S]*?class="[^"]*markdown[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim();
    if (text) turns.push(text);
  }
  if (turns.length > 0) return { title: 'ChatGPT Conversation', turns, url };

  throw new Error('Could not extract ChatGPT conversation. The link may be private or expired.');
}

// ─────────────────────────────────────────────
// Parse Claude — returns ordered list of turns (no role labels)
// Logs raw message keys to help debug structure if needed
// ─────────────────────────────────────────────
function parseClaude(data, url) {
  if (!data) throw new Error('No data intercepted from Claude. The page may have loaded too slowly or the link is invalid.');

  const conversation = data?.conversation || data;
  const rawMessages = conversation?.chat_messages || conversation?.messages || [];

  if (rawMessages.length === 0) throw new Error('Conversation found but contains no messages.');

  // Log the keys of the first message for debugging
  if (rawMessages[0]) console.log('Claude first message keys:', Object.keys(rawMessages[0]));

  const turns = [];
  for (const msg of rawMessages) {
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content.trim();
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
    } else if (typeof msg.text === 'string') {
      // Some API shapes use msg.text directly
      text = msg.text.trim();
    }
    if (text) turns.push(text);
  }

  if (turns.length === 0) throw new Error('No text content found in conversation.');

  const title = conversation?.name || conversation?.title || 'Claude Conversation';
  return { title, turns, url };
}

// ─────────────────────────────────────────────
// Build Markdown — no role labels, just dividers
// ─────────────────────────────────────────────
function buildMarkdown({ title, turns, url }) {
  const date = new Date().toISOString().split('T')[0];
  const DIVIDER = '='.repeat(40);
  const lines = [`# ${title}`, '', `> Extracted from: ${url}`, `> Date: ${date}`, ''];
  for (const text of turns) {
    lines.push(DIVIDER, '', text, '');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// POST /extract
// ─────────────────────────────────────────────
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
      const page = await fetchChatGPT(url);
      return res.json({ markdown: buildMarkdown(parseChatGPT(page, url)) });
    } else {
      const data = await fetchClaude(url);
      return res.json({ markdown: buildMarkdown(parseClaude(data, url)) });
    }
  } catch (err) {
    console.error('Extraction error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /debug-claude — dumps raw first message shape
// ─────────────────────────────────────────────
app.post('/debug-claude', async (req, res) => {
  const { url } = req.body;
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    let captured = null;
    page.on('response', async (response) => {
      if (response.url().includes('/api/chat_snapshots/')) {
        try { captured = await response.json(); } catch {}
      }
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 3000));
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

app.listen(PORT, () => {
  console.log(`✓ Chat Extractor running at http://localhost:${PORT}`);
});