/**
 * GREGORY — Chat Edge Function
 * Main chat endpoint with tool-use support.
 *
 * Handles both simple Q&A (backward-compatible) and tool-augmented responses.
 * When Claude decides to use a tool, it executes the tool and continues
 * generating, streaming progress events to the frontend.
 *
 * Request:  POST { message, history, agent, mode?, document_ids? }
 * Response: SSE stream (OpenAI-format deltas + named tool events)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  callLLM,
  callLLMStreaming,
  extractText,
  extractToolCalls,
  type ContentBlock,
  type Message,
  type ToolResultBlock,
  type ToolUseBlock,
} from "../_shared/llm.ts";
import {
  createSSEResponse,
  serializeDelta,
  serializeDone,
  serializeError,
  serializePlan,
  serializeToolCall,
  serializeToolResult,
  writeSSE,
} from "../_shared/protocol.ts";
import { executeTool, getToolSchemas, TOOL_REGISTRY } from "../_shared/tools.ts";
import { augmentWithToolInstructions, getAgentConfig } from "../_shared/agents.ts";
import {
  classifyRequest,
  generatePlan,
  createTaskContext,
} from "../_shared/planner.ts";
import {
  extractAndSaveMemories,
  getUserMemoryContext,
} from "../_shared/memory.ts";
import {
  checkRateLimit,
  getRateLimitKey,
  rateLimitResponse,
  CHAT_LIMIT,
} from "../_shared/rate-limit.ts";

// ── CORS ──

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── System Prompts (loaded from frontend agents.js via env or hardcoded fallback) ──
// In production, these are passed from the client-side config.
// The Edge Function receives the agent key and maps it to the system prompt.

// We store system prompts here to avoid relying on the client sending them.
// These must be kept in sync with public/agents.js.
// For now, we load them via a shared import mechanism.

interface ChatRequest {
  message: string;
  history: Array<{ role: string; content: string }>;
  agent: string | null;
  mode?: "simple" | "agentic";
  document_ids?: string[];
  systemPrompt?: string; // Passed from frontend for now
}

// ── Main Handler ──

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const { message, history, agent: agentKey, systemPrompt: clientSystemPrompt } = body;

  if (!message || typeof message !== "string") {
    return new Response(JSON.stringify({ error: "Message is required" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Get agent config and system prompt
  const agentConfig = getAgentConfig(agentKey);
  const baseSystemPrompt = clientSystemPrompt || agentConfig.systemPrompt;

  if (!baseSystemPrompt) {
    return new Response(JSON.stringify({ error: "System prompt not configured for agent" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Augment system prompt with domain-specific tool instructions
  let systemPrompt = augmentWithToolInstructions(baseSystemPrompt, agentKey);

  // Inject latest weekly intelligence briefs as background context
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );
    const { data: briefs } = await supabase
      .from("intelligence_cache")
      .select("category, title, content, data_date")
      .order("data_date", { ascending: false })
      .limit(4);

    if (briefs && briefs.length > 0) {
      const briefContext = briefs
        .map((b: { title: string; data_date: string; content: string }) =>
          `### ${b.title} (${b.data_date})\n${b.content}`
        )
        .join("\n\n");
      systemPrompt += `\n\n═══ WEEKLY INTELLIGENCE CONTEXT (auto-updated) ═══\n\nThe following briefs were last updated on ${briefs[0].data_date}. Reference this data when relevant — it provides current context without needing a tool call:\n\n${briefContext}`;
    }
  } catch {
    // Intelligence cache unavailable — proceed without it
  }

  // Extract user ID from auth token for memory
  let userId = "anonymous";
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );
    const { data: { user } } = await supabaseAuth.auth.getUser(token);
    if (user) userId = user.id;
  }

  // Rate limiting (after user ID extraction for accurate per-user limiting)
  const rateLimitKey = getRateLimitKey(req, userId);
  const rateResult = checkRateLimit(rateLimitKey, CHAT_LIMIT);
  if (!rateResult.allowed) {
    return rateLimitResponse(rateResult);
  }

  // Inject user memory context
  try {
    const memoryContext = await getUserMemoryContext(userId);
    if (memoryContext) {
      systemPrompt += memoryContext;
    }
  } catch {
    // Memory unavailable — proceed without it
  }

  // ── Agentic Routing ──
  // Classify the request to determine if it needs multi-step orchestration
  const forceMode = body.mode; // Frontend can force a mode
  let mode: "simple" | "agentic" = "simple";

  if (forceMode) {
    mode = forceMode;
  } else {
    try {
      const classification = await classifyRequest(message);
      mode = classification.mode;
      console.log(`Classification: ${mode} — ${classification.reasoning}`);
    } catch (err) {
      console.error("Classification failed, defaulting to simple:", err);
    }
  }

  // ── Agentic Path: Generate plan → persist task → stream plan for approval ──
  if (mode === "agentic") {
    const supabaseForTask = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );

    const { response, writer, encoder } = createSSEResponse();

    (async () => {
      try {
        // Generate the execution plan
        const taskId = crypto.randomUUID();
        const plan = await generatePlan(message, taskId);

        // Build system prompts map from the client prompt
        const systemPrompts: Record<string, string> = {};
        if (clientSystemPrompt) {
          systemPrompts[agentKey || "gregory"] = clientSystemPrompt;
        }

        // Persist task to DB
        const taskContext = createTaskContext(taskId, userId, plan);
        await supabaseForTask.from("tasks").insert({
          id: taskContext.task_id,
          user_id: taskContext.user_id,
          title: plan.title,
          plan: taskContext.plan,
          current_step_index: taskContext.current_step_index,
          step_results: taskContext.step_results,
          accumulated_context: taskContext.accumulated_context,
          status: taskContext.status,
          created_at: taskContext.created_at,
          updated_at: taskContext.updated_at,
        });

        // Stream the plan to the frontend for approval
        await writeSSE(writer, encoder, serializePlan(plan));

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error("Agentic planning error:", errorMsg);
        try {
          await writeSSE(writer, encoder, serializeError({
            message: `Failed to generate plan: ${errorMsg}`,
            recoverable: false,
          }));
        } catch { /* writer closed */ }
      } finally {
        try {
          await writeSSE(writer, encoder, serializeDone());
          await writer.close();
        } catch { /* already closed */ }
      }
    })();

    return response;
  }

  // ── Simple Path: Tool-augmented Q&A (existing flow) ──

  // Get tool schemas for this agent
  const agentTools = agentConfig.tools;
  const toolSchemas = getToolSchemas(agentTools);

  // Build message history for LLM
  const messages: Message[] = [];
  for (const msg of history) {
    messages.push({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    });
  }
  messages.push({ role: "user", content: message });

  // Set up SSE response
  const { response, writer, encoder } = createSSEResponse();

  // Process in background so we can return the response immediately
  (async () => {
    try {
      await processChat(systemPrompt, messages, toolSchemas, agentTools, writer, encoder);

      // Extract and save user memories in the background (non-blocking)
      if (userId !== "anonymous" && history.length >= 2) {
        const conversationSummary = history
          .slice(-6)
          .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
          .join("\n") + `\nuser: ${message}`;
        extractAndSaveMemories(userId, conversationSummary).catch(() => {});
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error("Chat processing error:", errorMsg);
      try {
        await writeSSE(writer, encoder, serializeError({
          message: errorMsg,
          recoverable: false,
        }));
      } catch {
        // Writer may be closed
      }
    } finally {
      try {
        await writeSSE(writer, encoder, serializeDone());
        await writer.close();
      } catch {
        // Writer may already be closed
      }
    }
  })();

  return response;
});

/**
 * Process a chat message with the agentic tool-use loop.
 *
 * Flow:
 * 1. Call Claude with the message + tool schemas
 * 2. Stream text deltas to the client
 * 3. If Claude calls a tool → execute it, notify client, feed result back to Claude
 * 4. Repeat until Claude produces a final text response (no more tool calls)
 */
async function processChat(
  systemPrompt: string,
  messages: Message[],
  toolSchemas: ReturnType<typeof getToolSchemas>,
  agentToolNames: string[],
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  const MAX_TOOL_ROUNDS = 5; // Safety limit to prevent infinite tool loops
  let round = 0;

  while (round < MAX_TOOL_ROUNDS) {
    round++;

    // Use streaming for the final response (no tools) or non-streaming for tool rounds
    // to keep logic simpler. After tool execution, we do another round.

    const response = await callLLMStreaming(
      {
        system: systemPrompt,
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        max_tokens: 4096,
        temperature: 0.7,
      },
      async (event) => {
        if (event.type === "text_delta" && event.text) {
          // Stream text deltas to client in OpenAI-compatible format
          await writeSSE(writer, encoder, serializeDelta(event.text));
        }
        // Tool events are handled after the full response is assembled
      },
    );

    // Check if Claude made tool calls
    const toolCalls = extractToolCalls(response.content);

    if (toolCalls.length === 0) {
      // No tool calls — we're done
      break;
    }

    // Execute tool calls and build tool results
    const toolResults: ToolResultBlock[] = [];

    for (const toolCall of toolCalls) {
      // Notify frontend about the tool call
      await writeSSE(writer, encoder, serializeToolCall({
        step_id: "chat",
        tool: toolCall.name,
        input: toolCall.input,
      }));

      // Execute the tool
      const result = await executeTool(toolCall.name, toolCall.input, {});

      // Notify frontend about the result
      await writeSSE(writer, encoder, serializeToolResult({
        step_id: "chat",
        tool: toolCall.name,
        success: result.success,
        preview: result.success
          ? truncatePreview(JSON.stringify(result.data))
          : result.error,
      }));

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: JSON.stringify(result.success ? result.data : { error: result.error }),
      });
    }

    // Add the assistant's response (with tool calls) and tool results to messages
    messages.push({
      role: "assistant",
      content: response.content,
    });
    messages.push({
      role: "user",
      content: toolResults,
    });

    // Continue the loop — Claude will process tool results and either
    // call more tools or produce a final text response
  }

  if (round >= MAX_TOOL_ROUNDS) {
    await writeSSE(writer, encoder, serializeError({
      message: "Reached maximum tool execution rounds. Returning available results.",
      recoverable: true,
    }));
  }
}

/**
 * Truncate a string for preview display.
 */
function truncatePreview(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + "...";
}
