type TextContent = { type: "text"; text: string };
type ToolResponse = { content: [TextContent] };

export function toolText(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

export function toolError(message: string): ToolResponse {
  return { content: [{ type: "text", text: `Error: ${message}` }] };
}

export function withErrorHandling(context: string, fn: () => ToolResponse): ToolResponse {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`${context}: ${message}`);
  }
}
