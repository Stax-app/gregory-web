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
  evaluateReplan,
  type TaskContext,
  type StepResult,
} from "../_shared/planner.ts";
import {
  checkRateLimit,
  getRateLimitKey,
  rateLimitResponse,
  ORCHESTRATE_LIMIT,
} from "../_shared/rate-limit.ts";
import {
  autoExtractCompanyIntel,
  logAnalytics,
  extractTopicTags,
} from "../_shared/knowledge-base.ts";

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
  let i = ctx.current_step_index;

  while (i < steps.length) {
    const step = steps[i];

    // Checkpoints disabled — skip and continue automatically
    // (checkpoint field is ignored even if present in plan)

    // Collect parallel group
    const parallelGroup = (step as PlanStep & { parallel_group?: string }).parallel_group;
    const parallelSteps: Array<{ step: PlanStep; index: number }> = [{ step, index: i }];

    if (parallelGroup) {
      for (let j = i + 1; j < steps.length; j++) {
        if ((steps[j] as PlanStep & { parallel_group?: string }).parallel_group === parallelGroup) {
          parallelSteps.push({ step: steps[j], index: j });
        } else {
          break;
        }
      }
    }

    if (parallelSteps.length > 1) {
      // Execute in parallel
      await writeSSE(writer, encoder, serializeDelta(`\n\n*Running ${parallelSteps.length} research steps in parallel...*\n\n`));

      const results = await Promise.allSettled(
        parallelSteps.map(async ({ step: pStep }) => {
          await writeSSE(writer, encoder, serializeStepUpdate({
            task_id: ctx.task_id,
            step_id: pStep.id,
            status: "running",
          }));

          const startTime = Date.now();
          const output = await executeStep(pStep, ctx, writer, encoder, systemPrompts);

          const stepResult: StepResult = {
            step_id: pStep.id,
            agent: pStep.agent,
            output,
            tool_calls_made: [],
            duration_ms: Date.now() - startTime,
            status: "completed",
          };

          ctx.step_results[pStep.id] = stepResult;

          await writeSSE(writer, encoder, serializeStepUpdate({
            task_id: ctx.task_id,
            step_id: pStep.id,
            status: "completed",
            summary: output.substring(0, 200),
          }));

          return stepResult;
        }),
      );

      // Handle failures
      for (const [idx, result] of results.entries()) {
        if (result.status === "rejected") {
          const pStep = parallelSteps[idx].step;
          ctx.step_results[pStep.id] = {
            step_id: pStep.id,
            agent: pStep.agent,
            output: (result.reason as Error)?.message || "Step failed",
            tool_calls_made: [],
            duration_ms: 0,
            status: "failed",
          };

          await writeSSE(writer, encoder, serializeStepUpdate({
            task_id: ctx.task_id,
            step_id: pStep.id,
            status: "failed",
            summary: (result.reason as Error)?.message || "Step failed",
          }));
        }
      }

      i = parallelSteps[parallelSteps.length - 1].index + 1;
    } else {
      // Sequential execution
      ctx.current_step_index = i;

      await writeSSE(writer, encoder, serializeStepUpdate({
        task_id: ctx.task_id,
        step_id: step.id,
        status: "running",
      }));

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

        await writeSSE(writer, encoder, serializeStepUpdate({
          task_id: ctx.task_id,
          step_id: step.id,
          status: "completed",
          summary: output.substring(0, 200),
        }));

      } catch (err) {
        ctx.step_results[step.id] = {
          step_id: step.id,
          agent: step.agent,
          output: (err as Error).message,
          tool_calls_made: [],
          duration_ms: Date.now() - startTime,
          status: "failed",
        };

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
      }

      i++;
    }

    // Update context after each step/group
    ctx.accumulated_context = await summarizeContext(ctx.step_results);

    // Persist progress
    await updateTask(supabase, ctx.task_id, {
      current_step_index: i,
      step_results: ctx.step_results,
      accumulated_context: ctx.accumulated_context,
    });

    // Dynamic re-planning check (every 2 completed steps)
    const completedIds = Object.keys(ctx.step_results).filter(id => ctx.step_results[id].status === "completed");
    if (completedIds.length > 0 && completedIds.length % 2 === 0 && i < steps.length) {
      try {
        const replanResult = await evaluateReplan(ctx.plan, completedIds, ctx.step_results, ctx.accumulated_context);
        if (replanResult.shouldReplan && replanResult.newSteps) {
          await writeSSE(writer, encoder, serializeDelta(`\n\n*Re-planning: ${replanResult.reason}*\n\n`));
          const completedSteps = ctx.plan.steps.slice(0, i);
          ctx.plan.steps = [...completedSteps, ...replanResult.newSteps];
          await supabase
            .from("tasks")
            .update({ plan: ctx.plan, updated_at: new Date().toISOString() })
            .eq("id", ctx.task_id);
        }
      } catch (e) {
        console.error("Re-planning check failed (non-fatal):", e);
      }
    }
  }

  // All steps complete — send final summary
  const finalSummary = ctx.accumulated_context || "Task completed.";
  await writeSSE(writer, encoder, serializeTaskComplete({
    task_id: ctx.task_id,
    summary: finalSummary,
  }));

  // Stream the final synthesis with critique
  await streamFinalSynthesis(ctx, writer, encoder, systemPrompts);

  await updateTask(supabase, ctx.task_id, { status: "completed" });

  // Extract company intelligence from all step outputs (non-blocking)
  const allOutputs = Object.values(ctx.step_results)
    .filter((r) => r.status === "completed" && r.output)
    .map((r) => r.output)
    .join("\n\n");
  if (allOutputs.length > 100) {
    autoExtractCompanyIntel(allOutputs, ctx.user_id).catch(() => {});
  }

  // Log task analytics (non-blocking)
  const topicTags = extractTopicTags(ctx.plan.title + " " + ctx.plan.steps.map(s => s.description).join(" "));
  logAnalytics({
    user_id: ctx.user_id !== "anonymous" ? ctx.user_id : undefined,
    session_id: ctx.task_id,
    agent_used: "orchestrate",
    topic_tags: topicTags,
    tools_used: Object.values(ctx.step_results).flatMap((r) => r.tool_calls_made || []),
    tool_call_count: Object.values(ctx.step_results).reduce((sum, r) => sum + (r.tool_calls_made?.length || 0), 0),
    message_count: ctx.plan.steps.length,
    mode: "agentic",
    task_id: ctx.task_id,
    query_complexity: "complex",
  }).catch(() => {});
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
  const MAX_TOOL_ROUNDS = 8;
  let round = 0;
  let fullText = "";
  let lastResponse: Awaited<ReturnType<typeof callLLMStreaming>> | null = null;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    // Only keep the final round's text for step output
    fullText = "";

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

    lastResponse = response;
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  return fullText || extractText(lastResponse?.content ?? []) || "Step completed with no text output.";
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

  // Phase 1: Synthesis with Opus + extended thinking + confidence scoring
  const synthesisMessage = `You are synthesizing the results of a multi-step research task.

TASK: "${ctx.plan.title}"

FINDINGS FROM ALL STEPS:
${ctx.accumulated_context}

---

Produce a comprehensive, executive-level synthesis that:
1. Leads with the key strategic recommendation
2. Integrates findings from all research steps
3. Cites specific data points with their sources (REPORTED/ESTIMATE labels)
4. For EVERY major claim, rate your confidence: [HIGH] = multiple corroborating sources, [MEDIUM] = single reliable source or logical inference, [LOW] = limited evidence or extrapolation
5. Provides actionable next steps
6. Notes any risks, gaps, or areas needing further investigation

Format with clear headings and be thorough but concise.`;

  let synthesisText = "";
  await callLLMStreaming(
    {
      system: systemPrompt,
      messages: [{ role: "user", content: synthesisMessage }],
      max_tokens: 8192,
      temperature: 0.4,
      useOpus: true,
      thinking: true,
      thinkingBudget: 8000,
    },
    async (event) => {
      if (event.type === "text_delta" && event.text) {
        synthesisText += event.text;
        await writeSSE(writer, encoder, serializeDelta(event.text));
      }
    },
  );

  // Phase 2: Devil's advocate critique
  await writeSSE(writer, encoder, serializeDelta("\n\n---\n\n## Critical Review\n\n"));

  const critiqueMessage = `You are a devil's advocate reviewer. Your job is to challenge the analysis below and identify weaknesses.

ANALYSIS TO CRITIQUE:
${synthesisText}

Provide a brief but sharp critique:
1. **Blind Spots**: What important factors or perspectives were missed?
2. **Weak Claims**: Which claims have the weakest evidence? Flag any [LOW] confidence claims.
3. **Alternative Interpretations**: Could the same data support a different conclusion?
4. **Missing Data**: What additional research would strengthen or potentially overturn these conclusions?

Be constructive but rigorous. 3-5 bullet points max.`;

  await callLLMStreaming(
    {
      system: "You are a rigorous analytical critic. Be specific, cite evidence gaps, and suggest concrete alternatives.",
      messages: [{ role: "user", content: critiqueMessage }],
      max_tokens: 1500,
      temperature: 0.5,
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
