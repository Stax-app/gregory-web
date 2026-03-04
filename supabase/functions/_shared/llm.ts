/**
 * GREGORY — LLM Client Module
 * Anthropic Messages API with native tool-use support + streaming
 */

// ── Types ──

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface Message {
  role: "user" | "assistant";
  content: string | (ContentBlock | ToolResultBlock)[];
}

export interface LLMRequest {
  system: string;
  messages: Message[];
  tools?: ToolSchema[];
  max_tokens?: number;
  temperature?: number;
  model?: string;
}

export interface LLMResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: { input_tokens: number; output_tokens: number };
}

export type StreamCallback = (event: StreamEvent) => void;

export interface StreamEvent {
  type: "text_delta" | "tool_use_start" | "tool_use_delta" | "tool_use_end" | "message_end";
  text?: string;
  tool_name?: string;
  tool_id?: string;
  tool_input?: Record<string, unknown>;
}

// ── Client ──

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 4096;

function getApiKey(): string {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  return key;
}

/**
 * Non-streaming call to the Anthropic Messages API.
 * Returns the full response including tool-use blocks.
 */
export async function callLLM(request: LLMRequest): Promise<LLMResponse> {
  const body: Record<string, unknown> = {
    model: request.model || DEFAULT_MODEL,
    max_tokens: request.max_tokens || DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: request.messages,
  };

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getApiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  return {
    content: data.content,
    stop_reason: data.stop_reason,
    usage: data.usage,
  };
}

/**
 * Streaming call to the Anthropic Messages API.
 * Streams text deltas and tool-use events via callback.
 * Returns the full assembled response.
 */
export async function callLLMStreaming(
  request: LLMRequest,
  onEvent: StreamCallback,
): Promise<LLMResponse> {
  const body: Record<string, unknown> = {
    model: request.model || DEFAULT_MODEL,
    max_tokens: request.max_tokens || DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: request.messages,
    stream: true,
  };

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getApiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${error}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Assembled response
  const contentBlocks: ContentBlock[] = [];
  let currentTextBlock: TextBlock | null = null;
  let currentToolBlock: ToolUseBlock | null = null;
  let toolInputJson = "";
  let stopReason: LLMResponse["stop_reason"] = "end_turn";
  let usage: LLMResponse["usage"] = { input_tokens: 0, output_tokens: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "text") {
            currentTextBlock = { type: "text", text: "" };
          } else if (block.type === "tool_use") {
            currentToolBlock = {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {},
            };
            toolInputJson = "";
            onEvent({ type: "tool_use_start", tool_name: block.name, tool_id: block.id });
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta" && currentTextBlock) {
            currentTextBlock.text += delta.text;
            onEvent({ type: "text_delta", text: delta.text });
          } else if (delta.type === "input_json_delta" && currentToolBlock) {
            toolInputJson += delta.partial_json;
            onEvent({ type: "tool_use_delta", tool_id: currentToolBlock.id });
          }
          break;
        }

        case "content_block_stop": {
          if (currentTextBlock) {
            contentBlocks.push(currentTextBlock);
            currentTextBlock = null;
          }
          if (currentToolBlock) {
            try {
              currentToolBlock.input = toolInputJson ? JSON.parse(toolInputJson) : {};
            } catch {
              currentToolBlock.input = {};
            }
            contentBlocks.push(currentToolBlock);
            onEvent({
              type: "tool_use_end",
              tool_name: currentToolBlock.name,
              tool_id: currentToolBlock.id,
              tool_input: currentToolBlock.input,
            });
            currentToolBlock = null;
            toolInputJson = "";
          }
          break;
        }

        case "message_delta": {
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
          if (event.usage) {
            usage = {
              input_tokens: usage.input_tokens,
              output_tokens: event.usage.output_tokens,
            };
          }
          break;
        }

        case "message_start": {
          if (event.message?.usage) {
            usage = {
              input_tokens: event.message.usage.input_tokens,
              output_tokens: usage.output_tokens,
            };
          }
          break;
        }
      }
    }
  }

  onEvent({ type: "message_end" });

  return {
    content: contentBlocks,
    stop_reason: stopReason,
    usage,
  };
}

/**
 * Extract text content from LLM response blocks.
 */
export function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Extract tool-use blocks from LLM response.
 */
export function extractToolCalls(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}
