/**
 * GREGORY — Task Planner Module
 *
 * Classifies requests as simple Q&A or agentic multi-step tasks,
 * then decomposes agentic requests into executable plans using
 * Claude's native tool-use.
 */

import { callLLM, extractToolCalls, extractText, type ToolSchema } from "./llm.ts";
import type { Plan, PlanStep } from "./protocol.ts";

// ── Classification ──

export interface ClassificationResult {
  mode: "simple" | "agentic";
  reasoning: string;
}

const CLASSIFY_TOOL: ToolSchema = {
  name: "classify_request",
  description: "Classify whether a user request is a simple question or requires multi-step agentic processing.",
  input_schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["simple", "agentic"],
        description: "simple = single-turn Q&A answer. agentic = requires research across multiple domains, tool calls, multi-step analysis, or deliverable creation.",
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of why this classification was chosen.",
      },
    },
    required: ["mode", "reasoning"],
  },
};

/**
 * Classify whether a user message needs simple Q&A or agentic multi-step processing.
 */
export async function classifyRequest(message: string): Promise<ClassificationResult> {
  const response = await callLLM({
    system: `You classify user requests for a marketing intelligence platform. Use the classify_request tool.

CLASSIFY AS "agentic" when the request:
- Requires research across 2+ domains (e.g. financial + regulatory + marketing)
- Asks for a deliverable (strategy, plan, report, audit, analysis)
- Uses phrases like "build me", "research", "compare", "analyze competitors", "create a plan"
- Would benefit from multiple tool calls across different data sources
- Requires synthesizing information from multiple steps

CLASSIFY AS "simple" when the request:
- Is a single question with a direct answer
- Asks about a concept, theory, or framework
- Requests an explanation or definition
- Can be fully answered in one response, even if it uses a tool or two
- Is a follow-up question in an ongoing conversation`,
    messages: [{ role: "user", content: message }],
    tools: [CLASSIFY_TOOL],
    max_tokens: 300,
    temperature: 0,
  });

  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length > 0) {
    const input = toolCalls[0].input as { mode: string; reasoning: string };
    return {
      mode: input.mode as "simple" | "agentic",
      reasoning: input.reasoning,
    };
  }

  // Fallback: if Claude didn't use the tool, default to simple
  return { mode: "simple", reasoning: "Classification fallback — defaulting to simple." };
}

// ── Plan Generation ──

const CREATE_PLAN_TOOL: ToolSchema = {
  name: "create_plan",
  description: "Decompose a complex request into a sequenced plan of research and analysis steps.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short title for this task (e.g. 'Competitive Landscape Analysis for AI Marketing Tools')",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Unique step ID (e.g. 'step-1', 'step-2')",
            },
            description: {
              type: "string",
              description: "What this step will do — specific enough to execute",
            },
            agent: {
              type: "string",
              enum: ["behavioral", "financial", "regulatory", "marketing", "gregory"],
              description: "Which specialist agent should handle this step",
            },
            tools_needed: {
              type: "array",
              items: { type: "string" },
              description: "Which tools this step will likely need (web_search, financial_data, etc.)",
            },
            depends_on: {
              type: "array",
              items: { type: "string" },
              description: "Step IDs that must complete before this step can run",
            },
            checkpoint: {
              type: "boolean",
              description: "Set to true if the user should review findings before proceeding past this step. Use checkpoints after research phases and before strategy/synthesis phases.",
            },
          },
          required: ["id", "description", "agent"],
        },
        description: "Ordered list of steps. Aim for 3-7 steps. Include at least one checkpoint.",
      },
    },
    required: ["title", "steps"],
  },
};

/**
 * Generate a multi-step execution plan for an agentic request.
 */
export async function generatePlan(
  message: string,
  taskId: string,
): Promise<Plan> {
  const response = await callLLM({
    system: `You are GREGORY's task planner. Given a complex user request, decompose it into a sequenced plan using the create_plan tool.

PLANNING GUIDELINES:
- Aim for 3-7 steps. More complex requests need more steps, but avoid over-decomposition.
- Assign each step to the most qualified specialist agent:
  - behavioral: psychology, consumer behavior, persuasion, cognitive biases
  - financial: company financials, valuation, market data, economic analysis
  - regulatory: compliance, legal, privacy, advertising regulations
  - marketing: campaigns, positioning, GTM, growth, conversion optimization
  - gregory: synthesis across domains, general strategy, final deliverable creation
- Steps run sequentially. Use depends_on to be explicit about dependencies.
- Include at least one checkpoint — typically after the research/analysis phase, before the synthesis/strategy phase.
- Be specific in step descriptions. "Research X" is too vague. "Analyze top 5 competitors' pricing, CAC, and revenue multiples using financial data and SEC filings" is good.
- The final step should almost always be a gregory (hub) synthesis step that combines all findings.
- List the tools each step will likely need.`,
    messages: [{ role: "user", content: message }],
    tools: [CREATE_PLAN_TOOL],
    max_tokens: 2000,
    temperature: 0.3,
  });

  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length > 0) {
    const input = toolCalls[0].input as { title: string; steps: PlanStep[] };
    return {
      task_id: taskId,
      title: input.title,
      steps: input.steps,
    };
  }

  // Fallback: create a single-step plan
  return {
    task_id: taskId,
    title: "Research Request",
    steps: [
      {
        id: "step-1",
        description: message,
        agent: "gregory",
        tools_needed: ["web_search"],
        checkpoint: false,
      },
    ],
  };
}

// ── Task Context ──

export interface TaskContext {
  task_id: string;
  user_id: string;
  plan: Plan;
  current_step_index: number;
  step_results: Record<string, StepResult>;
  accumulated_context: string;
  status: "planning" | "awaiting_approval" | "executing" | "checkpoint" | "completed" | "failed" | "aborted";
  created_at: string;
  updated_at: string;
}

export interface StepResult {
  step_id: string;
  agent: string;
  output: string;
  tool_calls_made: string[];
  duration_ms: number;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
}

/**
 * Create a new TaskContext from a plan.
 */
export function createTaskContext(
  taskId: string,
  userId: string,
  plan: Plan,
): TaskContext {
  return {
    task_id: taskId,
    user_id: userId,
    plan,
    current_step_index: 0,
    step_results: {},
    accumulated_context: "",
    status: "awaiting_approval",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Summarize accumulated step results into a condensed context string
 * for passing to subsequent steps. Keeps token usage manageable.
 */
export async function summarizeContext(
  stepResults: Record<string, StepResult>,
  maxLength: number = 3000,
): Promise<string> {
  const entries = Object.values(stepResults)
    .filter((r) => r.status === "completed" && r.output)
    .map((r) => `[${r.agent}] ${r.output}`);

  const rawContext = entries.join("\n\n---\n\n");

  if (rawContext.length <= maxLength) {
    return rawContext;
  }

  // Summarize using Claude if too long
  const response = await callLLM({
    system: "Condense the following research findings into a concise summary preserving all key data points, numbers, citations, and actionable insights. Keep specific figures and sources.",
    messages: [{ role: "user", content: rawContext }],
    max_tokens: 1500,
    temperature: 0,
  });

  return extractText(response.content) || rawContext.substring(0, maxLength);
}
