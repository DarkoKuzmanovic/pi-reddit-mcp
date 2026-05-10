# pi-reddit-mcp

MCP server for reading Reddit posts and comments in Pi.

## Tools

| Tool | Description |
|------|-------------|
| `read_reddit_post` | Read a post and its comments by URL or subreddit+ID |
| `search_reddit` | Search Reddit for posts matching a query |
| `read_reddit_subreddit` | Browse posts from a subreddit (hot/new/top/rising) |

## Install

1. Clone and build:

```bash
cd ~/.pi/agent/git/github.com/DarkoKuzmanovic
git clone <repo-url> pi-reddit-mcp
cd pi-reddit-mcp
npm install
npm run build
```

2. Add to `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "reddit": {
      "command": "node",
      "args": ["/path/to/pi-reddit-mcp/dist/index.js"]
    }
  }
}
```

3. Restart Pi.

## Usage

No Reddit account or API key needed — reads public posts via the JSON API with a proper User-Agent header.

### Examples

- Read a post: `read_reddit_post({ url: "https://www.reddit.com/r/PiCodingAgent/comments/abc123/..." })`
- Search: `search_reddit({ query: "pi coding agent", subreddit: "PiCodingAgent" })`
- Browse subreddit: `read_reddit_subreddit({ subreddit: "PiCodingAgent", sort: "hot" })`

### Parameters

**read_reddit_post**
- `url` — full Reddit post URL (or use `subreddit` + `postId`)
- `commentDepth` — max nesting depth (default: 5)
- `commentLimit` — max comments returned (default: 50)

**search_reddit**
- `query` — search string
- `subreddit` — restrict to a subreddit
- `sort` — relevance, hot, top, new, comments
- `limit` — max results (default: 10, max: 25)
- `time` — hour, day, week, month, year, all

**read_reddit_subreddit**
- `subreddit` — subreddit name (no r/ prefix)
- `sort` — hot, new, top, rising
- `limit` — max posts (default: 10, max: 25)
- `time` — for top sort: hour, day, week, month, year, all

## Rate limits

Reddit's public JSON API allows ~60 requests/minute. For heavy use, register a Reddit app and add OAuth support.

## License

MIT
