# Architecture: How ChatToMD Works

ChatToMD is a Node.js/Express application that uses a headless browser to load shared AI conversation pages and extract structured conversation data from them.

---

## The Problem with Direct Fetching

The naive approach — sending an HTTP request to the share URL and parsing the HTML — does not work for either platform.

Both ChatGPT (`chatgpt.com/share/...`) and Claude (`claude.ai/share/...`) are React-based single-page applications. A plain HTTP fetch returns an empty shell with no conversation content, because the data is loaded asynchronously by JavaScript after the initial page render. A server cannot execute that JavaScript.

---

## The Solution: Headless Browser + Data Interception

ChatToMD uses [Puppeteer](https://pptr.dev/) to launch a real headless Chrome instance. This means the page actually loads and executes — React hydrates, API calls fire, and the conversation data arrives exactly as it would in a normal browser session.

Rather than scraping the rendered DOM (which is fragile and dependent on CSS class names), ChatToMD intercepts the data at the source.

---

### ChatGPT: `__NEXT_DATA__` Extraction

ChatGPT's shared pages are built with Next.js. Next.js embeds the initial page data as a JSON blob inside a `<script id="__NEXT_DATA__">` tag in the HTML. This tag is populated server-side, before the page even reaches the browser, so it contains the full conversation before any JavaScript runs.

ChatToMD extracts this tag directly from the live DOM after the page loads:

```
__NEXT_DATA__
  └── props.pageProps.serverResponse.data
        ├── title              — conversation title
        └── mapping            — flat object of all message nodes
              └── [node]
                    ├── message.author.role   — 'user' | 'assistant'
                    ├── message.content.parts — array of text/code parts
                    └── children              — next node(s) in the tree
```

The `mapping` is a tree structure where each node has a parent and one or more children (branches occur when a message is regenerated). ChatToMD walks the tree depth-first, always following the last child to get the most recent branch.

---

### Claude: Network Response Interception

Claude's shared pages (`claude.ai/share/...`) do not use `__NEXT_DATA__`. The conversation is fetched at runtime via a separate API call:

```
GET /api/chat_snapshots/{share_id}
```

This response contains the full conversation JSON. ChatToMD uses Puppeteer's `page.on('response')` event listener to intercept this network response as soon as it arrives, before the page even finishes rendering.

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

Messages are extracted in index order. Text is pulled from the `text` field directly, with `content` blocks as a fallback.

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

All parsing logic lives in `server.js`. The frontend (`index.html`) is a single self-contained file with no framework dependency, it sends a `POST /extract` request and renders the returned Markdown in a preview box.
