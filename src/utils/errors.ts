type TextContent = { type: "text"; text: string };
type ToolResponse = { content: [TextContent]; isError?: boolean };

export function toolText(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

/** Failed tool call per the MCP spec: isError lets clients distinguish a
 * failure from a success that merely mentions an error; the message still
 * reaches the model as guidance for the retry. */
export function toolError(message: string): ToolResponse {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export function withErrorHandling(context: string, fn: () => ToolResponse): ToolResponse {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`${context}: ${message}`);
  }
}
