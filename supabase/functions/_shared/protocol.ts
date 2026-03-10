/**
 * GREGORY — SSE Protocol Module
 * Serializers for all event types in the agentic communication protocol.
 *
 * Event types:
 *   delta        — Text token (backward-compatible OpenAI format)
 *   plan         — Task plan for user approval
 *   step_update  — Step status change
 *   tool_call    — Tool invocation notification
 *   tool_result  — Tool execution result
 *   checkpoint   — Pause for user approval
 *   agent_handoff — Agent transition notification
 *   task_complete — Final task summary
 *   error        — Error notification
 */

// ── Types ──

export interface PlanStep {
  id: string;
  description: string;
  agent: string;
  tools_needed?: string[];
  depends_on?: string[];
  checkpoint?: boolean;
  parallel_group?: string;
}

export interface Plan {
  task_id: string;
  title: string;
  steps: PlanStep[];
}

export interface StepUpdate {
  task_id: string;
  step_id: string;
  status: "running" | "completed" | "failed";
  summary?: string;
}

export interface ToolCallEvent {
  step_id: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  step_id: string;
  tool: string;
  success: boolean;
  preview?: string;
}

export interface CheckpointEvent {
  task_id: string;
  step_id: string;
  summary: string;
  question?: string;
  findings?: Record<string, string>;
}

export interface AgentHandoffEvent {
  from: string;
  to: string;
  reason: string;
}

export interface TaskCompleteEvent {
  task_id: string;
  summary: string;
}

export interface ErrorEvent {
  step_id?: string;
  message: string;
  recoverable: boolean;
}

export interface ThinkingEvent {
  content: string;
}

export interface ConfidenceEvent {
  task_id: string;
  overall_confidence: number;
  claim_scores: Array<{ claim: string; confidence: "high" | "medium" | "low"; evidence: string }>;
}

export interface ReplanEvent {
  task_id: string;
  reason: string;
  new_steps: string[];
}

// ── SSE Helpers ──

/**
 * Encode an SSE event string.
 * Named events use the `event:` field; data-only events are backward-compatible.
 */
function sseEvent(eventType: string | null, data: string): string {
  let out = "";
  if (eventType) out += `event: ${eventType}\n`;
  out += `data: ${data}\n\n`;
  return out;
}

// ── Serializers ──

/**
 * Text delta — backward-compatible with existing OpenAI SSE format.
 * Frontend parses: data.choices[0].delta.content
 */
export function serializeDelta(content: string): string {
  return sseEvent(null, JSON.stringify({
    choices: [{ delta: { content } }],
  }));
}

/** Task plan for user approval */
export function serializePlan(plan: Plan): string {
  return sseEvent("plan", JSON.stringify(plan));
}

/** Step status update */
export function serializeStepUpdate(update: StepUpdate): string {
  return sseEvent("step_update", JSON.stringify(update));
}

/** Tool call notification */
export function serializeToolCall(event: ToolCallEvent): string {
  return sseEvent("tool_call", JSON.stringify(event));
}

/** Tool result notification */
export function serializeToolResult(event: ToolResultEvent): string {
  return sseEvent("tool_result", JSON.stringify(event));
}

/** Checkpoint — pause for user approval */
export function serializeCheckpoint(event: CheckpointEvent): string {
  return sseEvent("checkpoint", JSON.stringify(event));
}

/** Agent handoff notification */
export function serializeAgentHandoff(event: AgentHandoffEvent): string {
  return sseEvent("agent_handoff", JSON.stringify(event));
}

/** Task completion */
export function serializeTaskComplete(event: TaskCompleteEvent): string {
  return sseEvent("task_complete", JSON.stringify(event));
}

/** Error notification */
export function serializeError(event: ErrorEvent): string {
  return sseEvent("error", JSON.stringify(event));
}

/** Thinking content (for extended thinking display) */
export function serializeThinking(event: ThinkingEvent): string {
  return sseEvent("thinking", JSON.stringify(event));
}

/** Confidence scores */
export function serializeConfidence(event: ConfidenceEvent): string {
  return sseEvent("confidence", JSON.stringify(event));
}

/** Re-planning notification */
export function serializeReplan(event: ReplanEvent): string {
  return sseEvent("replan", JSON.stringify(event));
}

/** Stream terminator — backward-compatible */
export function serializeDone(): string {
  return "data: [DONE]\n\n";
}

// ── Response Helpers ──

/**
 * Create an SSE-streaming Response with proper headers.
 */
export function createSSEResponse(): {
  response: Response;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
} {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  const response = new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });

  return { response, writer, encoder };
}

/**
 * Write an SSE string to the stream.
 */
export async function writeSSE(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  data: string,
): Promise<void> {
  await writer.write(encoder.encode(data));
}
