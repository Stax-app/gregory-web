/**
 * GREGORY — Orchestration Engine
 *
 * Executes approved multi-step agentic plans. Each step runs an agent
 * with its system prompt, accumulated context from prior steps, and
 * available tools. Streams progress events to the frontend.
 *
 * Handles:
 * - Plan execution (step by step)
 * - Checkpoint persistence (pause → save to DB → resume later)
 * - Task continuation after user approval
 * - Agent handoff between steps
 *
 * Endpoints:
 * POST { task_id, action: "start" }               — Begin executing an approved plan
 * POST { task_id, action: "continue" }             — Resume after checkpoint approval
 * POST { task_id, action: "modify", feedback: "" } — Resume with modified direction
 * POST { task_id, action: "abort" }                — Cancel the task
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  callLLMStreaming,
  extractText,
  extractToolCalls,
  type Message,
  type ToolResultBlock,
} from "../_shared/llm.ts";
import {
  createSSEResponse,
  serializeAgentHandoff,
  serializeCheckpoint,
  serializeDelta,
  serializeDone,
  serializeError,
  serializeStepUpdate,
  serializeTaskComplete,
  serializeToolCall,
  serializeToolResult,
  writeSSE,
  type PlanStep,
} from "../_shared/protocol.ts";
import { executeTool, getToolSchemas } from "../_shared/tools.ts";
import { augmentWithToolInstructions, getAgentConfig } from "../_shared/agents.ts";
import {
  summarizeContext,
  type TaskContext,
  type StepResult,
} from "../_shared/planner.ts";
import {
  checkRateLimit,
  getRateLimitKey,
  rateLimitResponse,
  ORCHESTRATE_LIMIT,
} from "../_shared/rate-limit.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface OrchestrateRequest {
  task_id: string;
  action: "start" | "continue" | "modify" | "abort";
  feedback?: string;
  systemPrompts?: Record<string, string>; // agent key → system prompt (from frontend)
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  let body: OrchestrateRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );

  const { task_id, action, feedback, systemPrompts } = body;

  // Rate limiting — only for new task starts (not resumptions)
  if (action === "start") {
    const rateLimitKey = getRateLimitKey(req);
    const rateResult = checkRateLimit(rateLimitKey, ORCHESTRATE_LIMIT);
    if (!rateResult.allowed) {
      return rateLimitResponse(rateResult);
    }
  }

  // Load task context from DB
  const { data: taskRow, error: taskError } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", task_id)
    .single();

  if (taskError || !taskRow) {
    return new Response(JSON.stringify({ error: "Task not found" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const taskContext: TaskContext = {
    task_id: taskRow.id,
    user_id: taskRow.user_id,
    plan: taskRow.plan,
    current_step_index: taskRow.current_step_index,
    step_results: taskRow.step_results || {},
    accumulated_context: taskRow.accumulated_context || "",
    status: taskRow.status,
    created_at: taskRow.created_at,
    updated_at: taskRow.updated_at,
  };

  // Handle abort
  if (action === "abort") {
    await updateTask(supabase, task_id, { status: "aborted" });
    return new Response(JSON.stringify({ success: true, status: "aborted" }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Handle modify — inject feedback into context and continue
  if (action === "modify" && feedback) {
    taskContext.accumulated_context += `\n\n[USER FEEDBACK]: ${feedback}`;
  }

  // Update status to executing
  await updateTask(supabase, task_id, { status: "executing" });
  taskContext.status = "executing";

  // Set up SSE response
  const { response, writer, encoder } = createSSEResponse();

  // Execute in background
  (async () => {
    try {
      await executeSteps(taskContext, supabase, writer, encoder, systemPrompts || {});
    } catch (err) {
      console.error("Orchestration error:", err);
      try {
        await writeSSE(writer, encoder, serializeError({
          message: (err as Error).message,
          recoverable: false,
        }));
        await updateTask(supabase, task_id, { status: "failed" });
      } catch { /* writer closed */ }
    } finally {
      try {
        await writeSSE(writer, encoder, serializeDone());
        await writer.close();
      } catch { /* already closed */ }
    }
  })();

  return response;
});

// ── Step Execution Loop ──

async function executeSteps(
  ctx: TaskContext,
  supabase: SupabaseClient,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  systemPrompts: Record<string, string>,
): Promise<void> {
  const steps = ctx.plan.steps;
  const startIndex = ctx.current_step_index;

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    ctx.current_step_index = i;

    // Check if this is a checkpoint step
    if (step.checkpoint && i > startIndex) {
      // Summarize findings so far
      const summary = await summarizeContext(ctx.step_results);
      ctx.accumulated_context = summary;

      // Send checkpoint event
      await writeSSE(writer, encoder, serializeCheckpoint({
        task_id: ctx.task_id,
        step_id: step.id,
        summary: summary,
        question: `Research complete for steps 1-${i}. Review the findings above and approve to continue with: "${step.description}"`,
      }));

      // Save state and stop — frontend will call back with continue/modify/abort
      await updateTask(supabase, ctx.task_id, {
        status: "checkpoint",
        current_step_index: i,
        step_results: ctx.step_results,
        accumulated_context: ctx.accumulated_context,
      });

      return; // Exit — will resume on next invocation
    }

    // Notify step starting
    await writeSSE(writer, encoder, serializeStepUpdate({
      task_id: ctx.task_id,
      step_id: step.id,
      status: "running",
    }));

    // Agent handoff notification
    const prevAgent = i > 0 ? steps[i - 1].agent : null;
    if (prevAgent && prevAgent !== step.agent) {
      const agentConfig = getAgentConfig(step.agent);
      const prevConfig = getAgentConfig(prevAgent);
      await writeSSE(writer, encoder, serializeAgentHandoff({
        from: prevConfig.shortName,
        to: agentConfig.shortName,
        reason: step.description,
      }));
    }

    // Execute the step
    const startTime = Date.now();
    try {
      const output = await executeStep(step, ctx, writer, encoder, systemPrompts);

      const stepResult: StepResult = {
        step_id: step.id,
        agent: step.agent,
        output,
        tool_calls_made: [],
        duration_ms: Date.now() - startTime,
        status: "completed",
      };

      ctx.step_results[step.id] = stepResult;

      // Update accumulated context
      ctx.accumulated_context = await summarizeContext(ctx.step_results);

      await writeSSE(writer, encoder, serializeStepUpdate({
        task_id: ctx.task_id,
        step_id: step.id,
        status: "completed",
        summary: output.substring(0, 200),
      }));

    } catch (err) {
      const stepResult: StepResult = {
        step_id: step.id,
        agent: step.agent,
        output: (err as Error).message,
        tool_calls_made: [],
        duration_ms: Date.now() - startTime,
        status: "failed",
      };

      ctx.step_results[step.id] = stepResult;

      await writeSSE(writer, encoder, serializeStepUpdate({
        task_id: ctx.task_id,
        step_id: step.id,
        status: "failed",
        summary: (err as Error).message,
      }));

      await writeSSE(writer, encoder, serializeError({
        step_id: step.id,
        message: `Step failed: ${(err as Error).message}`,
        recoverable: true,
      }));

      // Continue to next step despite failure
    }

    // Persist progress after each step
    await updateTask(supabase, ctx.task_id, {
      current_step_index: i + 1,
      step_results: ctx.step_results,
      accumulated_context: ctx.accumulated_context,
    });
  }

  // All steps complete — send final summary
  const finalSummary = ctx.accumulated_context || "Task completed.";
  await writeSSE(writer, encoder, serializeTaskComplete({
    task_id: ctx.task_id,
    summary: finalSummary,
  }));

  // Stream the final synthesis as text deltas so the user sees it in the chat
  await streamFinalSynthesis(ctx, writer, encoder, systemPrompts);

  await updateTask(supabase, ctx.task_id, { status: "completed" });
}

// ── Single Step Execution ──

async function executeStep(
  step: PlanStep,
  ctx: TaskContext,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  systemPrompts: Record<string, string>,
): Promise<string> {
  const agentConfig = getAgentConfig(step.agent);

  // Get the agent's system prompt (from frontend or config)
  const basePrompt = systemPrompts[step.agent] || systemPrompts["gregory"] || agentConfig.systemPrompt;
  if (!basePrompt) {
    throw new Error(`No system prompt available for agent: ${step.agent}`);
  }

  const systemPrompt = augmentWithToolInstructions(basePrompt, step.agent);

  // Build the step message with accumulated context
  let stepMessage = step.description;
  if (ctx.accumulated_context) {
    stepMessage = `CONTEXT FROM PRIOR RESEARCH STEPS:\n${ctx.accumulated_context}\n\n---\n\nYOUR TASK FOR THIS STEP:\n${step.description}\n\nBuild on the prior research above. Be specific, cite data sources, and provide actionable findings.`;
  }

  // Get tool schemas for this agent
  const toolSchemas = getToolSchemas(agentConfig.tools);

  // Execute with tool-use loop
  const messages: Message[] = [{ role: "user", content: stepMessage }];
  const MAX_TOOL_ROUNDS = 5;
  let round = 0;
  let fullText = "";

  while (round < MAX_TOOL_ROUNDS) {
    round++;

    const response = await callLLMStreaming(
      {
        system: systemPrompt,
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        max_tokens: 4096,
        temperature: 0.5,
      },
      async (event) => {
        if (event.type === "text_delta" && event.text) {
          fullText += event.text;
          await writeSSE(writer, encoder, serializeDelta(event.text));
        }
      },
    );

    const toolCalls = extractToolCalls(response.content);

    if (toolCalls.length === 0) break;

    // Execute tool calls
    const toolResults: ToolResultBlock[] = [];
    for (const tc of toolCalls) {
      await writeSSE(writer, encoder, serializeToolCall({
        step_id: step.id,
        tool: tc.name,
        input: tc.input,
      }));

      const result = await executeTool(tc.name, tc.input, {
        user_id: ctx.user_id,
        task_id: ctx.task_id,
      });

      await writeSSE(writer, encoder, serializeToolResult({
        step_id: step.id,
        tool: tc.name,
        success: result.success,
        preview: result.success
          ? JSON.stringify(result.data).substring(0, 150)
          : result.error,
      }));

      toolResults.push({
        type: "tool_result",
        tool_use_id: tc.id,
        content: JSON.stringify(result.success ? result.data : { error: result.error }),
      });
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  return fullText || extractText([]) || "Step completed with no text output.";
}

// ── Final Synthesis ──

async function streamFinalSynthesis(
  ctx: TaskContext,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  systemPrompts: Record<string, string>,
): Promise<void> {
  const hubPrompt = systemPrompts["gregory"] || getAgentConfig("gregory").systemPrompt;
  if (!hubPrompt) return;

  const systemPrompt = augmentWithToolInstructions(hubPrompt, "gregory");

  const synthesisMessage = `You are synthesizing the results of a multi-step research task.

TASK: "${ctx.plan.title}"

FINDINGS FROM ALL STEPS:
${ctx.accumulated_context}

---

Produce a comprehensive, executive-level synthesis that:
1. Leads with the key strategic recommendation
2. Integrates findings from all research steps
3. Cites specific data points with their sources (REPORTED/ESTIMATE labels)
4. Provides actionable next steps
5. Notes any risks, gaps, or areas needing further investigation

Format with clear headings and be thorough but concise.`;

  await callLLMStreaming(
    {
      system: systemPrompt,
      messages: [{ role: "user", content: synthesisMessage }],
      max_tokens: 4096,
      temperature: 0.4,
    },
    async (event) => {
      if (event.type === "text_delta" && event.text) {
        await writeSSE(writer, encoder, serializeDelta(event.text));
      }
    },
  );
}

// ── DB Helpers ──

async function updateTask(
  supabase: SupabaseClient,
  taskId: string,
  updates: Partial<{
    status: string;
    current_step_index: number;
    step_results: Record<string, StepResult>;
    accumulated_context: string;
  }>,
): Promise<void> {
  await supabase
    .from("tasks")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", taskId);
}
