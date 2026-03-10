/**
 * GREGORY — User Memory Module
 *
 * Persistent cross-session memory for each user. Extracts notable facts,
 * preferences, and prior findings from conversations and stores them
 * in the user_memory table. Retrieves relevant memories to inject
 * into system prompts for personalized context.
 *
 * Categories:
 * - company_info:     Company name, industry, size, target market
 * - preferences:      Communication style, formatting, focus areas
 * - prior_findings:   Key conclusions from past research tasks
 * - contacts:         Names/roles the user mentions working with
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, extractToolCalls, type ToolSchema } from "./llm.ts";

// ── Types ──

export interface MemoryEntry {
  id: string;
  user_id: string;
  category: string;
  content: string;
  source_task_id?: string;
  created_at: string;
}

// ── Memory Extraction ──

const EXTRACT_MEMORY_TOOL: ToolSchema = {
  name: "save_memories",
  description: "Extract notable facts from a conversation to remember for future sessions.",
  input_schema: {
    type: "object",
    properties: {
      memories: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: ["company_info", "preferences", "prior_findings", "contacts", "entity_relationship", "analysis_outcome", "data_point"],
              description: "Category of this memory",
            },
            content: {
              type: "string",
              description: "The fact to remember — concise, specific, and actionable",
            },
          },
          required: ["category", "content"],
        },
        description: "List of facts to save. Only extract truly useful, persistent facts.",
      },
    },
    required: ["memories"],
  },
};

/**
 * Simple semantic similarity check using word overlap.
 * Returns true if the new content is too similar to an existing memory.
 */
function isSimilar(existing: string, candidate: string, threshold = 0.7): boolean {
  const a = existing.toLowerCase().trim();
  const b = candidate.toLowerCase().trim();
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return (intersection / union) >= threshold;
}

/**
 * Extract memorable facts from a conversation and store them.
 * Called at the end of a chat session or after task completion.
 */
export async function extractAndSaveMemories(
  userId: string,
  conversationSummary: string,
  taskId?: string,
): Promise<number> {
  if (!userId || userId === "anonymous") return 0;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );

  // Ask Claude to extract notable facts
  const response = await callLLM({
    system: `You extract persistent facts from conversations that would be useful to remember in future sessions with this user. Use the save_memories tool.

EXTRACT facts like:
- The user's company name, industry, role, team size
- Their preferred communication style or formatting
- Key decisions or conclusions from research tasks
- Relationships between entities (e.g. "Company X is a competitor of Company Y in the SaaS space")
- Specific data points discovered (e.g. "Nike's DTC revenue was $21.3B in FY2024")
- Outcomes of analyses (e.g. "Our analysis showed AAPL is undervalued by 15% on DCF basis")
- Names of colleagues, clients, or stakeholders they mention
- Specific preferences ("always include competitor analysis", "focus on B2B SaaS")

DO NOT extract:
- Session-specific details that won't matter next time
- Generic information anyone would know
- The user's question itself (that's not a memory)
- Anything speculative or uncertain

Be very selective — only save facts you're confident about. 2-5 facts per conversation is typical. If nothing notable, return an empty array.`,
    messages: [{ role: "user", content: conversationSummary }],
    tools: [EXTRACT_MEMORY_TOOL],
    max_tokens: 500,
    temperature: 0,
  });

  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length === 0) return 0;

  const extracted = toolCalls[0].input as {
    memories: Array<{ category: string; content: string }>;
  };

  if (!extracted.memories || extracted.memories.length === 0) return 0;

  // Check for duplicates before inserting
  const { data: existing } = await supabase
    .from("user_memory")
    .select("content")
    .eq("user_id", userId);

  const existingContents = (existing || []).map((m: { content: string }) => m.content);

  const newMemories = extracted.memories.filter(
    (m) => !existingContents.some(ex => isSimilar(ex, m.content)),
  );

  if (newMemories.length === 0) return 0;

  // Insert new memories
  const rows = newMemories.map((m) => ({
    user_id: userId,
    category: m.category,
    content: m.content,
    source_task_id: taskId || null,
  }));

  const { error } = await supabase.from("user_memory").insert(rows);
  if (error) {
    console.error("Failed to save memories:", error);
    return 0;
  }

  return newMemories.length;
}

// ── Memory Retrieval ──

/**
 * Retrieve user memories for injection into the system prompt.
 * Returns a formatted string of memories grouped by category.
 */
export async function getUserMemoryContext(userId: string): Promise<string> {
  if (!userId || userId === "anonymous") return "";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );

  const { data: memories, error } = await supabase
    .from("user_memory")
    .select("category, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100); // Increased capacity for knowledge graph

  if (error || !memories || memories.length === 0) return "";

  // Group by category
  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m.content);
  }

  const categoryLabels: Record<string, string> = {
    company_info: "About This User's Company",
    preferences: "User Preferences",
    prior_findings: "Key Findings from Prior Sessions",
    contacts: "People & Stakeholders",
    entity_relationship: "Known Entities & Relationships",
    analysis_outcome: "Outcomes from Prior Analyses",
    data_point: "Key Data Points Collected",
  };

  let context = "\n\n══ USER MEMORY (persistent across sessions) ══\n\n";
  for (const [category, items] of Object.entries(grouped)) {
    const label = categoryLabels[category] || category;
    context += `### ${label}\n`;
    context += items.map((item) => `- ${item}`).join("\n");
    context += "\n\n";
  }

  context += "Use this context to personalize your responses. Reference prior findings when relevant.";

  return context;
}

/**
 * Delete a specific memory by ID.
 */
export async function deleteMemory(
  userId: string,
  memoryId: string,
): Promise<boolean> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );

  const { error } = await supabase
    .from("user_memory")
    .delete()
    .eq("id", memoryId)
    .eq("user_id", userId);

  return !error;
}

/**
 * Search user memories by keyword relevance (RAG-style retrieval).
 */
export async function searchMemories(
  userId: string,
  query: string,
  limit = 10,
): Promise<MemoryEntry[]> {
  if (!userId || userId === "anonymous") return [];

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );

  const { data: memories, error } = await supabase
    .from("user_memory")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error || !memories) return [];

  const queryWords = new Set(query.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2));

  const scored = memories.map((m: MemoryEntry) => {
    const contentWords = m.content.toLowerCase().split(/\s+/);
    const matchCount = contentWords.filter((w: string) => queryWords.has(w)).length;
    const score = matchCount / Math.max(queryWords.size, 1);
    return { memory: m, score };
  });

  return scored
    .filter((s: { score: number }) => s.score > 0)
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
    .slice(0, limit)
    .map((s: { memory: MemoryEntry }) => s.memory);
}
