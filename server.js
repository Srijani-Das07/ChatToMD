const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const LAUNCH_OPTIONS = () => ({
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
  ],
});

// Shared user agent
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────
// ChatGPT: load page, extract __NEXT_DATA__ + HTML
// Bug fixes:
//   - Use domcontentloaded instead of networkidle2 (faster, more reliable)
//   - Try multiple known __NEXT_DATA__ paths before giving up
//   - Improved DOM fallback: use innerText per message block, not regex on full HTML
// ─────────────────────────────────────────────
async function fetchChatGPT(url) {
  const browser = await puppeteer.launch(LAUNCH_OPTIONS());
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for messages to appear; fall back to a fixed delay if they don't
    try {
      await page.waitForSelector('[data-message-author-role]', { timeout: 12000 });
    } catch {
      await new Promise(r => setTimeout(r, 5000));
    }

    const nextData = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch { return null; }
    });

    const html = await page.content();

    // Also capture DOM text as a structured fallback while the page is still open
    const domTurns = await page.evaluate(() => {
      const nodes = document.querySelectorAll('[data-message-author-role]');
      const turns = [];
      nodes.forEach(node => {
        const text = node.innerText?.trim();
        if (text) turns.push(text);
      });
      return turns;
    });

    return { html, nextData, domTurns };
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// Claude: intercept /api/chat_snapshots/ response
// Bug fixes:
//   - Use waitForResponse instead of page.on('response') to eliminate race condition
//   - Broaden URL match to cover API path variations
//   - Use domcontentloaded + waitForResponse instead of networkidle2 + fixed delay
// ─────────────────────────────────────────────
async function fetchClaude(url) {
  const browser = await puppeteer.launch(LAUNCH_OPTIONS());
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);

    // Set up the response waiter BEFORE navigation so we don't miss it
    const isConversationResponse = (res) => {
      const u = res.url();
      return (
        u.includes('/api/chat_snapshots/') ||
        u.includes('/api/share/') ||
        (u.includes('/share/') && u.includes('conversation'))
      );
    };

    const [conversationResponse] = await Promise.all([
      page.waitForResponse(isConversationResponse, { timeout: 45000 }),
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
    ]);

    const conversationData = await conversationResponse.json();
    return conversationData;
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// Extract text from a ChatGPT parts array
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
// Parse ChatGPT
// Bug fixes:
//   - Try multiple known __NEXT_DATA__ paths (structure varies by ChatGPT version)
//   - DOM fallback now uses live innerText captured by Puppeteer (not regex on HTML)
// ─────────────────────────────────────────────
function parseChatGPT({ html, nextData, domTurns }, url) {
  if (nextData) {
    // Try all known data paths — ChatGPT's Next.js structure has varied over time
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

  // DOM fallback: use the live innerText we captured in fetchChatGPT
  if (domTurns && domTurns.length > 0) {
    console.log(`[ChatGPT] __NEXT_DATA__ parse failed; using DOM fallback (${domTurns.length} turns)`);
    return { title: 'ChatGPT Conversation', turns: domTurns, url };
  }

  throw new Error('Could not extract ChatGPT conversation. The link may be private or expired.');
}

// ─────────────────────────────────────────────
// Parse Claude
// Bug fixes:
//   - Prefer content blocks over msg.text (content has full formatting)
//   - Fall back to msg.text only when content is missing/empty, with a warning
//   - Log meaningful info if no turns are found to aid debugging
// ─────────────────────────────────────────────
function parseClaude(data, url) {
  if (!data) throw new Error('No data intercepted from Claude. The link may be private, expired, or the page structure changed.');

  const conversation = data?.conversation || data;
  const rawMessages = conversation?.chat_messages || conversation?.messages || [];

  if (rawMessages.length === 0) throw new Error('Conversation found but contains no messages.');

  if (rawMessages[0]) console.log('[Claude] First message keys:', Object.keys(rawMessages[0]));

  const turns = [];
  for (const msg of rawMessages) {
    let text = '';

    // Prefer structured content blocks (richer, includes formatting)
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    }

    // Fall back to top-level string content
    if (!text && typeof msg.content === 'string') {
      text = msg.content.trim();
    }

    // Last resort: msg.text (plain-text stripped version)
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

// ─────────────────────────────────────────────
// Build Markdown
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
// POST /debug-claude
// Bug fixes: same race condition fix applied here too
// ─────────────────────────────────────────────
app.post('/debug-claude', async (req, res) => {
  const { url } = req.body;
  const browser = await puppeteer.launch(LAUNCH_OPTIONS());
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);

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

app.listen(PORT, () => {
  console.log(`✓ Chat Extractor running at http://localhost:${PORT}`);
});