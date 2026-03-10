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

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

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
  useOpus?: boolean;
  thinking?: boolean;
  thinkingBudget?: number;
}

export interface LLMResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: { input_tokens: number; output_tokens: number };
}

export type StreamCallback = (event: StreamEvent) => void | Promise<void>;

export interface StreamEvent {
  type: "text_delta" | "tool_use_start" | "tool_use_delta" | "tool_use_end" | "message_end" | "thinking_delta";
  text?: string;
  thinking?: string;
  tool_name?: string;
  tool_id?: string;
  tool_input?: Record<string, unknown>;
}

// ── Client ──
// Supports both Anthropic native API and OpenRouter (OpenAI-compatible).
// Checks ANTHROPIC_API_KEY first; falls back to OPENROUTER_API_KEY.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL_ANTHROPIC = "claude-sonnet-4-20250514";
const OPUS_MODEL_ANTHROPIC = "claude-opus-4-20250514";
const DEFAULT_MODEL_OPENROUTER = "anthropic/claude-sonnet-4";
const OPUS_MODEL_OPENROUTER = "anthropic/claude-opus-4";
const DEFAULT_MAX_TOKENS = 4096;

type Provider = "anthropic" | "openrouter";

function getProvider(): { provider: Provider; apiKey: string } {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (anthropicKey) return { provider: "anthropic", apiKey: anthropicKey };
  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (openrouterKey) return { provider: "openrouter", apiKey: openrouterKey };
  throw new Error("No LLM API key set. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.");
}

// ── Format Converters (Anthropic ↔ OpenAI) ──

function toOpenAIMessages(
  system: string,
  messages: Message[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    } else {
      // Convert Anthropic content blocks to OpenAI format
      if (m.role === "assistant") {
        const textParts = (m.content as ContentBlock[])
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        const toolCalls = (m.content as ContentBlock[])
          .filter((b): b is ToolUseBlock => b.type === "tool_use")
          .map((b) => ({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
        const msg: Record<string, unknown> = { role: "assistant" };
        if (textParts) msg.content = textParts;
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        out.push(msg);
      } else {
        // User message with tool results
        const blocks = m.content as (ContentBlock | ToolResultBlock)[];
        for (const b of blocks) {
          if ((b as ToolResultBlock).type === "tool_result") {
            const tr = b as ToolResultBlock;
            out.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: tr.content,
            });
          }
        }
      }
    }
  }
  return out;
}

function toOpenAITools(tools: ToolSchema[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function openAIStopToAnthropic(
  finishReason: string | null,
  hasToolCalls: boolean,
): LLMResponse["stop_reason"] {
  if (hasToolCalls || finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return "end_turn";
}

// ── Anthropic Native API ──

async function callAnthropicDirect(
  request: LLMRequest,
  apiKey: string,
): Promise<LLMResponse> {
  const model = request.useOpus ? OPUS_MODEL_ANTHROPIC : (request.model || DEFAULT_MODEL_ANTHROPIC);
  const body: Record<string, unknown> = {
    model,
    max_tokens: request.max_tokens || DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: request.messages,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools?.length) body.tools = request.tools;

  // Extended thinking support
  if (request.thinking) {
    body.thinking = { type: "enabled", budget_tokens: request.thinkingBudget || 10000 };
    body.temperature = 1; // Required by Anthropic for thinking
    if ((body.max_tokens as number) < 16000) body.max_tokens = 16000;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  if (request.thinking) {
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  return { content: data.content, stop_reason: data.stop_reason, usage: data.usage };
}

async function callAnthropicStreaming(
  request: LLMRequest,
  apiKey: string,
  onEvent: StreamCallback,
): Promise<LLMResponse> {
  const model = request.useOpus ? OPUS_MODEL_ANTHROPIC : (request.model || DEFAULT_MODEL_ANTHROPIC);
  const body: Record<string, unknown> = {
    model,
    max_tokens: request.max_tokens || DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: request.messages,
    stream: true,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools?.length) body.tools = request.tools;

  // Extended thinking support
  if (request.thinking) {
    body.thinking = { type: "enabled", budget_tokens: request.thinkingBudget || 10000 };
    body.temperature = 1;
    if ((body.max_tokens as number) < 16000) body.max_tokens = 16000;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  if (request.thinking) {
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${error}`);
  }

  return parseAnthropicStream(response, onEvent);
}

async function parseAnthropicStream(
  response: Response,
  onEvent: StreamCallback,
): Promise<LLMResponse> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const contentBlocks: ContentBlock[] = [];
  let currentTextBlock: TextBlock | null = null;
  let currentToolBlock: ToolUseBlock | null = null;
  let currentThinkingBlock: ThinkingBlock | null = null;
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
      try { event = JSON.parse(data); } catch { continue; }

      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "text") {
            currentTextBlock = { type: "text", text: "" };
          } else if (block.type === "thinking") {
            currentThinkingBlock = { type: "thinking", thinking: "" };
          } else if (block.type === "tool_use") {
            currentToolBlock = { type: "tool_use", id: block.id, name: block.name, input: {} };
            toolInputJson = "";
            await onEvent({ type: "tool_use_start", tool_name: block.name, tool_id: block.id });
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta" && currentTextBlock) {
            currentTextBlock.text += delta.text;
            await onEvent({ type: "text_delta", text: delta.text });
          } else if (delta.type === "thinking_delta" && currentThinkingBlock) {
            currentThinkingBlock.thinking += delta.thinking;
            await onEvent({ type: "thinking_delta", thinking: delta.thinking });
          } else if (delta.type === "input_json_delta" && currentToolBlock) {
            toolInputJson += delta.partial_json;
            await onEvent({ type: "tool_use_delta", tool_id: currentToolBlock.id });
          }
          break;
        }
        case "content_block_stop": {
          if (currentTextBlock) { contentBlocks.push(currentTextBlock); currentTextBlock = null; }
          if (currentThinkingBlock) { contentBlocks.push(currentThinkingBlock); currentThinkingBlock = null; }
          if (currentToolBlock) {
            try { currentToolBlock.input = toolInputJson ? JSON.parse(toolInputJson) : {}; } catch { currentToolBlock.input = {}; }
            contentBlocks.push(currentToolBlock);
            await onEvent({ type: "tool_use_end", tool_name: currentToolBlock.name, tool_id: currentToolBlock.id, tool_input: currentToolBlock.input });
            currentToolBlock = null;
            toolInputJson = "";
          }
          break;
        }
        case "message_delta": {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          if (event.usage) usage = { input_tokens: usage.input_tokens, output_tokens: event.usage.output_tokens };
          break;
        }
        case "message_start": {
          if (event.message?.usage) usage = { input_tokens: event.message.usage.input_tokens, output_tokens: usage.output_tokens };
          break;
        }
      }
    }
  }

  await onEvent({ type: "message_end" });
  return { content: contentBlocks, stop_reason: stopReason, usage };
}

// ── OpenRouter (OpenAI-compatible) API ──

async function callOpenRouterDirect(
  request: LLMRequest,
  apiKey: string,
): Promise<LLMResponse> {
  const messages = toOpenAIMessages(request.system, request.messages);
  const model = request.useOpus ? OPUS_MODEL_OPENROUTER : (request.model || DEFAULT_MODEL_OPENROUTER);
  const body: Record<string, unknown> = {
    model,
    max_tokens: request.max_tokens || DEFAULT_MAX_TOKENS,
    messages,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools?.length) body.tools = toOpenAITools(request.tools);

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const msg = choice?.message;

  // Convert OpenAI response to Anthropic content blocks
  const contentBlocks: ContentBlock[] = [];
  if (msg?.content) {
    contentBlocks.push({ type: "text", text: msg.content });
  }
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      contentBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || "{}"),
      });
    }
  }

  return {
    content: contentBlocks,
    stop_reason: openAIStopToAnthropic(choice?.finish_reason, !!msg?.tool_calls?.length),
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

async function callOpenRouterStreaming(
  request: LLMRequest,
  apiKey: string,
  onEvent: StreamCallback,
): Promise<LLMResponse> {
  const messages = toOpenAIMessages(request.system, request.messages);
  const model = request.useOpus ? OPUS_MODEL_OPENROUTER : (request.model || DEFAULT_MODEL_OPENROUTER);
  const body: Record<string, unknown> = {
    model,
    max_tokens: request.max_tokens || DEFAULT_MAX_TOKENS,
    messages,
    stream: true,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools?.length) body.tools = toOpenAITools(request.tools);

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${error}`);
  }

  return parseOpenAIStream(response, onEvent);
}

async function parseOpenAIStream(
  response: Response,
  onEvent: StreamCallback,
): Promise<LLMResponse> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const contentBlocks: ContentBlock[] = [];
  let currentText = "";
  // Track tool calls by index
  const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
  let finishReason: string | null = null;
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
      try { event = JSON.parse(data); } catch { continue; }

      const delta = event.choices?.[0]?.delta;
      const fr = event.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;

      if (delta?.content) {
        currentText += delta.content;
        await onEvent({ type: "text_delta", text: delta.content });
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, { id: tc.id || "", name: tc.function?.name || "", args: "" });
            if (tc.function?.name) {
              await onEvent({ type: "tool_use_start", tool_name: tc.function.name, tool_id: tc.id });
            }
          }
          const existing = toolCalls.get(idx)!;
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
        }
      }

      if (event.usage) {
        usage = {
          input_tokens: event.usage.prompt_tokens || 0,
          output_tokens: event.usage.completion_tokens || 0,
        };
      }
    }
  }

  // Finalize content blocks
  if (currentText) {
    contentBlocks.push({ type: "text", text: currentText });
  }
  for (const [, tc] of toolCalls) {
    let input: Record<string, unknown> = {};
    try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { input = {}; }
    contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    await onEvent({ type: "tool_use_end", tool_name: tc.name, tool_id: tc.id, tool_input: input });
  }

  await onEvent({ type: "message_end" });
  return {
    content: contentBlocks,
    stop_reason: openAIStopToAnthropic(finishReason, toolCalls.size > 0),
    usage,
  };
}

// ── Public API (provider-agnostic) ──

/**
 * Non-streaming LLM call. Auto-detects provider from available API keys.
 */
export async function callLLM(request: LLMRequest): Promise<LLMResponse> {
  const { provider, apiKey } = getProvider();
  if (provider === "anthropic") return callAnthropicDirect(request, apiKey);
  return callOpenRouterDirect(request, apiKey);
}

/**
 * Streaming LLM call. Auto-detects provider from available API keys.
 * Streams text deltas and tool-use events via callback.
 */
export async function callLLMStreaming(
  request: LLMRequest,
  onEvent: StreamCallback,
): Promise<LLMResponse> {
  const { provider, apiKey } = getProvider();
  if (provider === "anthropic") return callAnthropicStreaming(request, apiKey, onEvent);
  return callOpenRouterStreaming(request, apiKey, onEvent);
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

/**
 * Extract thinking content from LLM response blocks.
 */
export function extractThinking(content: ContentBlock[]): string {
  return content
    .filter((b): b is ThinkingBlock => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n");
}
