import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Reddit API helpers ──────────────────────────────────────────────────────

const USER_AGENT = "pi-reddit-mcp/1.0 (by /u/pi-user)";

interface RedditListing {
	kind: string;
	data: {
		children: RedditChild[];
		after: string | null;
		before: string | null;
	};
}

interface RedditChild {
	kind: string; // "t3" = post, "t1" = comment
	data: Record<string, unknown>;
}

interface PostData {
	id: string;
	title: string;
	author: string;
	subreddit: string;
	selftext: string;
	score: number;
	upvote_ratio: number;
	num_comments: number;
	created_utc: number;
	url: string;
	permalink: string;
	link_flair_text: string | null;
	is_self: boolean;
	over_18: boolean;
	spoiler: boolean;
}

interface CommentData {
	id: string;
	author: string;
	body: string;
	score: number;
	created_utc: number;
	permalink: string;
	replies: RedditListing | string; // string means "more" or empty
}

function formatTimestamp(utc: number): string {
	return new Date(utc * 1000)
		.toISOString()
		.replace("T", " ")
		.replace(".000Z", " UTC");
}

async function redditFetch(url: string): Promise<unknown> {
	const resp = await fetch(url, {
		headers: { "User-Agent": USER_AGENT },
		signal: AbortSignal.timeout(15_000),
	});
	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		throw new Error(
			`Reddit API ${resp.status}: ${resp.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
		);
	}
	const text = await resp.text();
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(
			`Reddit API returned non-JSON response (${resp.status}, first 200 chars: ${text.slice(0, 200)})`,
		);
	}
}

function extractPost(data: Record<string, unknown>): PostData {
	return {
		id: data.id as string,
		title: data.title as string,
		author: (data.author as string) ?? "[deleted]",
		subreddit: data.subreddit as string,
		selftext: data.selftext as string,
		score: data.score as number,
		upvote_ratio: data.upvote_ratio as number,
		num_comments: data.num_comments as number,
		created_utc: data.created_utc as number,
		url: data.url as string,
		permalink: data.permalink as string,
		link_flair_text: (data.link_flair_text as string) ?? null,
		is_self: data.is_self as boolean,
		over_18: data.over_18 as boolean,
		spoiler: data.spoiler as boolean,
	};
}

function formatPost(p: PostData): string {
	const lines = [
		`# ${p.title}`,
		`**r/${p.subreddit}** · u/${p.author} · ${formatTimestamp(p.created_utc)}`,
		`⬆ ${p.score} (${Math.round(p.upvote_ratio * 100)}%) · 💬 ${p.num_comments} comments`,
	];
	if (p.link_flair_text) lines.push(`🏷 ${p.link_flair_text}`);
	if (p.over_18) lines.push(`⚠ NSFW`);
	if (p.spoiler) lines.push(`⚠ Spoiler`);
	lines.push("");
	if (p.selftext) lines.push(p.selftext);
	if (!p.is_self) lines.push(`🔗 ${p.url}`);
	lines.push(`\nhttps://reddit.com${p.permalink}`);
	return lines.join("\n");
}

function extractComment(data: Record<string, unknown>): CommentData {
	return {
		id: data.id as string,
		author: (data.author as string) ?? "[deleted]",
		body: data.body as string,
		score: data.score as number,
		created_utc: data.created_utc as number,
		permalink: data.permalink as string,
		replies: data.replies as RedditListing | string,
	};
}

function flattenComments(
	children: RedditChild[],
	depth: number,
	maxDepth: number,
	results: { depth: number; comment: CommentData }[],
): void {
	if (depth > maxDepth) return;
	for (const child of children) {
		if (child.kind === "t1") {
			const comment = extractComment(child.data);
			results.push({ depth, comment });
			if (
				typeof comment.replies === "object" &&
				comment.replies?.data?.children
			) {
				flattenComments(
					comment.replies.data.children,
					depth + 1,
					maxDepth,
					results,
				);
			}
		}
	}
}

function formatCommentTree(
	children: RedditChild[],
	maxDepth: number,
	limit: number,
): string {
	const flat: { depth: number; comment: CommentData }[] = [];
	flattenComments(children, 0, maxDepth, flat);
	const sliced = flat.slice(0, limit);
	const lines: string[] = [];
	for (const { depth, comment } of sliced) {
		const indent = "  ".repeat(depth);
		lines.push(
			`${indent}u/${comment.author} · ⬆${comment.score} · ${formatTimestamp(comment.created_utc)}`,
			`${indent}${comment.body.split("\n").join(`\n${indent}`)}`,
			"",
		);
	}
	if (flat.length > limit) {
		lines.push(`... and ${flat.length - limit} more comments`);
	}
	return lines.join("\n");
}

// ── URL parsing ─────────────────────────────────────────────────────────────

function parseRedditUrl(
	url: string,
): { subreddit: string; postId: string; commentId?: string } | null {
	// Match patterns like:
	// https://www.reddit.com/r/subreddit/comments/POST_ID/title/
	// https://www.reddit.com/r/subreddit/comments/POST_ID/title/COMMENT_ID/
	// https://reddit.com/r/subreddit/comments/POST_ID/title/
	// https://old.reddit.com/r/subreddit/comments/POST_ID/title/
	const pattern =
		/(?:www\.|old\.|new\.)?reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)(?:\/[^/]*\/([a-z0-9]+)?)?/i;
	const match = url.match(pattern);
	if (!match) return null;
	return {
		subreddit: match[1],
		postId: match[2],
		commentId: match[3] || undefined,
	};
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
	name: "pi-reddit-mcp",
	version: "1.0.0",
});

server.tool(
	"read_reddit_post",
	"Read a Reddit post and its comments. Provide a Reddit post URL or a subreddit name + post ID.",
	{
		url: z
			.string()
			.optional()
			.describe(
				"Full Reddit post URL (e.g. https://www.reddit.com/r/PiCodingAgent/comments/abc123/...)",
			),
		subreddit: z
			.string()
			.optional()
			.describe(
				"Subreddit name (without r/ prefix). Used with postId if no URL.",
			),
		postId: z
			.string()
			.optional()
			.describe(
				"Reddit post ID (the alphanumeric string in the URL). Used with subreddit if no URL.",
			),
		commentDepth: z
			.number()
			.optional()
			.describe(
				"Max comment nesting depth (default: 5). Set lower for top-level-only, higher for deep threads.",
			),
		commentLimit: z
			.number()
			.optional()
			.describe("Max comments to return (default: 50)."),
	},
	async (args) => {
		let subreddit: string;
		let postId: string;

		if (args.url) {
			const parsed = parseRedditUrl(args.url);
			if (!parsed) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Could not parse Reddit URL: ${args.url}`,
						},
					],
					isError: true,
				};
			}
			subreddit = parsed.subreddit;
			postId = parsed.postId;
		} else if (args.subreddit && args.postId) {
			if (!/^[a-zA-Z0-9_]+$/.test(args.subreddit)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Invalid subreddit name: ${args.subreddit}`,
						},
					],
					isError: true,
				};
			}
			if (!/^[a-zA-Z0-9]+$/.test(args.postId)) {
				return {
					content: [
						{ type: "text", text: `Error: Invalid post ID: ${args.postId}` },
					],
					isError: true,
				};
			}
			subreddit = args.subreddit;
			postId = args.postId;
		} else {
			return {
				content: [
					{
						type: "text",
						text: "Error: Provide either a 'url' or both 'subreddit' and 'postId'.",
					},
				],
				isError: true,
			};
		}

		const maxDepth = args.commentDepth ?? 5;
		const maxComments = args.commentLimit ?? 50;

		try {
			const apiUrl = `https://www.reddit.com/r/${subreddit}/comments/${postId}.json`;
			const data = (await redditFetch(apiUrl)) as [
				RedditListing,
				RedditListing,
			];

			if (!Array.isArray(data) || data.length < 2) {
				return {
					content: [
						{
							type: "text",
							text: "Error: Unexpected Reddit API response format.",
						},
					],
					isError: true,
				};
			}

			const postListing = data[0].data.children;
			if (postListing.length === 0 || postListing[0].kind !== "t3") {
				return {
					content: [{ type: "text", text: "Error: Post not found." }],
					isError: true,
				};
			}

			const post = extractPost(postListing[0].data);
			let output = formatPost(post);

			// Comments
			const commentChildren = data[1].data.children;
			const commentCount = commentChildren.filter(
				(c) => c.kind === "t1",
			).length;
			if (commentCount > 0) {
				output += `\n\n---\n\n## Comments\n\n`;
				output += formatCommentTree(commentChildren, maxDepth, maxComments);
			}

			return { content: [{ type: "text", text: output }] };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `Error fetching Reddit post: ${msg}` }],
				isError: true,
			};
		}
	},
);

server.tool(
	"search_reddit",
	"Search Reddit for posts matching a query. Returns a list of matching posts with titles, scores, and snippets.",
	{
		query: z.string().describe("Search query"),
		subreddit: z
			.string()
			.optional()
			.describe("Limit search to a specific subreddit (without r/ prefix)"),
		sort: z
			.enum(["relevance", "hot", "top", "new", "comments"])
			.optional()
			.describe("Sort order (default: relevance)"),
		limit: z
			.number()
			.optional()
			.describe("Max results to return (default: 10, max: 25)"),
		time: z
			.enum(["hour", "day", "week", "month", "year", "all"])
			.optional()
			.describe("Time range for top sort (default: all)"),
	},
	async (args) => {
		const sort = args.sort ?? "relevance";
		const limit = Math.min(args.limit ?? 10, 25);
		const time = args.time ?? "all";

		const params = new URLSearchParams({
			q: args.query,
			sort,
			limit: String(limit),
			t: time,
			type: "link",
		});
		if (args.subreddit) {
			if (!/^[a-zA-Z0-9_]+$/.test(args.subreddit)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Invalid subreddit name: ${args.subreddit}`,
						},
					],
					isError: true,
				};
			}
			params.set("restrict_sr", "on");
		}

		const path = args.subreddit
			? `/r/${args.subreddit}/search.json`
			: `/search.json`;

		try {
			const data = (await redditFetch(
				`https://www.reddit.com${path}?${params}`,
			)) as RedditListing;
			if (!data.data || !Array.isArray(data.data.children)) {
				return {
					content: [
						{ type: "text", text: `No results found for "${args.query}".` },
					],
				};
			}
			const children = data.data.children.filter((c) => c.kind === "t3");

			if (children.length === 0) {
				return {
					content: [
						{ type: "text", text: `No results found for "${args.query}".` },
					],
				};
			}

			const lines: string[] = [`## Search results for "${args.query}"`, ""];
			for (let i = 0; i < children.length; i++) {
				const post = extractPost(children[i].data);
				const snippet = post.selftext
					? post.selftext.slice(0, 150).replace(/\n/g, " ") + "..."
					: "";
				lines.push(
					`### ${i + 1}. ${post.title}`,
					`r/${post.subreddit} · u/${post.author} · ⬆${post.score} · 💬${post.num_comments} · ${formatTimestamp(post.created_utc)}`,
					snippet ? `> ${snippet}` : "",
					`https://reddit.com${post.permalink}`,
					"",
				);
			}
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `Error searching Reddit: ${msg}` }],
				isError: true,
			};
		}
	},
);

server.tool(
	"read_reddit_subreddit",
	"Read posts from a subreddit. Returns the current hot/new/top posts.",
	{
		subreddit: z.string().describe("Subreddit name (without r/ prefix)"),
		sort: z
			.enum(["hot", "new", "top", "rising"])
			.optional()
			.describe("Sort order (default: hot)"),
		limit: z
			.number()
			.optional()
			.describe("Max posts to return (default: 10, max: 25)"),
		time: z
			.enum(["hour", "day", "week", "month", "year", "all"])
			.optional()
			.describe("Time range for top sort (default: day)"),
	},
	async (args) => {
		const sort = args.sort ?? "hot";
		const limit = Math.min(args.limit ?? 10, 25);
		const time = args.time ?? "day";

		try {
			if (!/^[a-zA-Z0-9_]+$/.test(args.subreddit)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Invalid subreddit name: ${args.subreddit}`,
						},
					],
					isError: true,
				};
			}
			const params = new URLSearchParams({
				sort,
				limit: String(limit),
				t: time,
			});

			const data = (await redditFetch(
				`https://www.reddit.com/r/${args.subreddit}/${sort}.json?${params}`,
			)) as RedditListing;

			if (!data.data || !Array.isArray(data.data.children)) {
				return {
					content: [
						{ type: "text", text: `No posts found in r/${args.subreddit}.` },
					],
				};
			}
			const children = data.data.children.filter((c) => c.kind === "t3");

			if (children.length === 0) {
				return {
					content: [
						{ type: "text", text: `No posts found in r/${args.subreddit}.` },
					],
				};
			}

			const lines: string[] = [`## r/${args.subreddit} (${sort})`, ""];
			for (let i = 0; i < children.length; i++) {
				const post = extractPost(children[i].data);
				const snippet = post.selftext
					? post.selftext.slice(0, 120).replace(/\n/g, " ") + "..."
					: "";
				lines.push(
					`### ${i + 1}. ${post.title}`,
					`u/${post.author} · ⬆${post.score} · 💬${post.num_comments} · ${formatTimestamp(post.created_utc)}`,
					snippet ? `> ${snippet}` : "",
					`https://reddit.com${post.permalink}`,
					"",
				);
			}
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `Error fetching subreddit: ${msg}` }],
				isError: true,
			};
		}
	},
);

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
