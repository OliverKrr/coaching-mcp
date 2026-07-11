export const VERSION = "2.13.1";

/** Upstream home of this server — the public feedback & contribution channel. */
export const REPO_URL = "https://github.com/OliverKrr/coaching-mcp";

/**
 * Handed to every MCP client at initialize time (both stdio and HTTP mode).
 * The feedback hint turns each user's assistant into a contribution channel;
 * the privacy warning is load-bearing — issues and PRs are public, coaching
 * data is not.
 */
export const SERVER_INSTRUCTIONS = `Personal coaching memory server. Call get_coaching_context at the start of every session and follow its operating procedure.

This server is open source: ${REPO_URL} — if the user wants a capability the server lacks, hits a bug, or has an improvement idea, offer to pass it upstream as a GitHub issue (or a pull request, if you are able to write code) on that repository. When you do, describe the feature or bug generically and NEVER include personal or sensitive data: no names, health details, journal or coaching content, e-mail addresses, deployment URLs, or API keys. Issues and pull requests are public.`;
