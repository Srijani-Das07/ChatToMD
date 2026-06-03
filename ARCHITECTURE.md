# Architecture: How ChatToMD Works

ChatToMD is a Node.js/Express application that uses a headless browser to load shared AI conversation pages and extract structured conversation data from them.

---

## The Problem with Direct Fetching

The naive approach of sending an HTTP request to the share URL and parsing the HTML does not work for either platform.

Both ChatGPT (`chatgpt.com/share/...`) and Claude (`claude.ai/share/...`) are React-based single-page applications. A plain HTTP fetch returns an empty shell with no conversation content, because the data is loaded asynchronously by JavaScript after the initial page render. A server cannot execute that JavaScript.

---

## The Solution: Headless Browser + Data Interception

ChatToMD uses [Puppeteer](https://pptr.dev/) to launch a real headless Chrome instance. This means the page actually loads and executes — React hydrates, API calls fire, and the conversation data arrives exactly as it would in a normal browser session.

Rather than scraping the rendered DOM (which is fragile and dependent on CSS class names), ChatToMD intercepts the data at the source.

---

## Why Two Different Strategies

ChatGPT and Claude are built differently at a fundamental level, so a single extraction strategy cannot cover both.

ChatGPT's share pages are rendered by Next.js, which performs server-side rendering and embeds the full conversation data into the HTML before it ever reaches the browser. The data is sitting in the page's `__NEXT_DATA__` script tag and can be read directly from the DOM — no need to watch network traffic at all.

Claude's share pages do not use server-side rendering for conversation content. The page shell loads first, then the browser makes a separate API request at runtime to fetch the conversation JSON. There is no equivalent of `__NEXT_DATA__` to read; the data only exists as a network response.

Trying to apply the ChatGPT approach to Claude would yield nothing, because the conversation is never embedded in the HTML. Trying to apply the Claude approach to ChatGPT would be unnecessarily complex, because the data is already present in the DOM before any network request is made.

---

### ChatGPT: `__NEXT_DATA__` Extraction

ChatGPT's shared pages are built with Next.js. Next.js embeds the initial page data as a JSON blob inside a `<script id="__NEXT_DATA__">` tag in the HTML. This tag is populated server-side, before the page even reaches the browser, so it contains the full conversation before any JavaScript runs.

**Why `__NEXT_DATA__` instead of DOM parsing**

The alternative would be to let the page render fully and then scrape the visible message elements from the DOM. That approach has two problems. First, production builds of React apps use minified, hashed CSS class names, so any selector targeting a class like `markdown` will break whenever ChatGPT redeploys. Second, scraping rendered HTML means working with a lossy representation — code blocks, formatting, and structure have already been transformed into display elements, making faithful reconstruction difficult.

`__NEXT_DATA__` is a structured JSON payload written by the server, not a rendered artifact. It contains the raw conversation data exactly as the backend provided it, independent of how the frontend chooses to display it. Selectors and class names are irrelevant.

ChatToMD extracts this tag directly from the live DOM after the page loads. Because ChatGPT's Next.js data structure has varied across versions, multiple known paths are tried in order:

```
__NEXT_DATA__
  └── props.pageProps.serverResponse.data  (primary)
  └── props.pageProps.data                 (fallback 1)
  └── props.pageProps                      (fallback 2)
        ├── title              — conversation title
        └── mapping            — flat object of all message nodes
              └── [node]
                    ├── message.author.role   — 'user' | 'assistant'
                    ├── message.content.parts — array of text/code parts
                    └── children              — next node(s) in the tree
```

The `mapping` is a tree structure where each node has a parent and one or more children (branches occur when a message is regenerated). ChatToMD walks the tree depth-first, always following the last child to get the most recent branch.

If none of the `__NEXT_DATA__` paths yield content, ChatToMD falls back to querying `[data-message-author-role]` nodes directly in the live DOM via Puppeteer, capturing their `innerText` while the page is still open. This avoids the fragility of running regex over raw HTML.

---

### Claude: Network Response Interception

Claude's shared pages (`claude.ai/share/...`) do not use `__NEXT_DATA__`. The conversation is fetched at runtime via a separate API call. The known endpoint patterns are:

```
GET /api/chat_snapshots/{share_id}
GET /api/share/{share_id}/conversation
```

**Why `waitForResponse` instead of `page.on('response')`**

`page.on('response', async (response) => { ... })` attaches a passive event listener. The callback is async, which means the JSON read happens after the event fires — but `page.goto()` does not wait for any of those callbacks to complete. On a fast connection, `goto()` can resolve with `waitUntil: 'networkidle2'` before `response.json()` has finished, leaving `conversationData` as `null`. The timing depends entirely on network speed and system load, making the bug intermittent and hard to reproduce.

`page.waitForResponse()` returns a Promise that resolves to the matched response object only after the response has been received. Wrapping it in a `Promise.all` alongside `page.goto()` means both are set up before navigation begins, so the response cannot arrive before the listener is ready. The data is fully available before execution continues.

Rather than attaching a passive `page.on('response')` listener, ChatToMD uses `page.waitForResponse()` in a `Promise.all` alongside `page.goto()`. This ensures the response is awaited correctly regardless of how quickly the page loads.

```js
const [conversationResponse] = await Promise.all([
  page.waitForResponse(isConversationResponse, { timeout: 45000 }),
  page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
]);
```

The response shape:

```
{
  name: "Conversation Title",
  chat_messages: [
    {
      sender: "human" | "assistant",
      text: "...",
      content: [{ type: "text", text: "..." }],
      ...
    }
  ]
}
```

Messages are extracted in index order. Text is pulled from `content` blocks first (which carry full formatting), with `msg.text` as a last resort fallback.

---

## Output Format

Turns are separated by a divider with no role labels, preserving the natural back-and-forth flow of the conversation:

```markdown
# Conversation Title

> Extracted from: https://...
> Date: YYYY-MM-DD

========================================

First message text here.

========================================

Second message text here.

========================================
```

---

## Project Structure

```
ChatToMD/
├── server.js       # Express server, Puppeteer logic, parsers
├── index.html      # Single-page frontend
├── package-lock.json
├── package.json
├── README.md
├── ARCHITECTURE.md
├── LICENSE
├── .gitignore
└── assets/
    └── ui.png
```

All parsing logic lives in `server.js`. The frontend (`index.html`) is a single self-contained file with no framework dependency; it sends a `POST /extract` request and renders the returned Markdown in a preview box.