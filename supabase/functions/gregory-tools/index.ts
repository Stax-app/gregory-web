/**
 * GREGORY — Document Upload Handler
 *
 * Receives file uploads via multipart form data, stores them in
 * Supabase Storage, creates a metadata row in the documents table,
 * and returns the document ID for use with the analyze_document tool.
 *
 * Endpoints:
 * POST /                — Upload a document (multipart/form-data)
 * GET  /?id={doc_id}    — Get document metadata
 * DELETE /?id={doc_id}  — Delete a document
 *
 * Supported formats: PDF, CSV, XLSX, TXT, JSON, Markdown, HTML, DOCX
 * Max file size: 10MB
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  checkRateLimit,
  getRateLimitKey,
  rateLimitResponse,
  UPLOAD_LIMIT,
} from "../_shared/rate-limit.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/markdown",
  "text/html",
  "application/json",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );

  // Extract user from auth token (optional — anonymous uploads allowed for now)
  let userId = "anonymous";
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) userId = user.id;
  }

  const url = new URL(req.url);

  // ── GET: Document metadata ──
  if (req.method === "GET") {
    const docId = url.searchParams.get("id");
    if (!docId) {
      return jsonResponse({ error: "Document ID required" }, 400);
    }

    const { data: doc, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();

    if (error || !doc) {
      return jsonResponse({ error: "Document not found" }, 404);
    }

    return jsonResponse(doc);
  }

  // ── DELETE: Remove document ──
  if (req.method === "DELETE") {
    const docId = url.searchParams.get("id");
    if (!docId) {
      return jsonResponse({ error: "Document ID required" }, 400);
    }

    const { data: doc } = await supabase
      .from("documents")
      .select("storage_path")
      .eq("id", docId)
      .single();

    if (doc) {
      await supabase.storage.from("documents").remove([doc.storage_path]);
      await supabase.from("documents").delete().eq("id", docId);
    }

    return jsonResponse({ success: true });
  }

  // ── POST: Upload document ──
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Rate limiting for uploads
  const rateLimitKey = getRateLimitKey(req, userId);
  const rateResult = checkRateLimit(rateLimitKey, UPLOAD_LIMIT);
  if (!rateResult.allowed) {
    return rateLimitResponse(rateResult);
  }

  const contentType = req.headers.get("content-type") || "";

  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse({ error: "Expected multipart/form-data" }, 400);
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return jsonResponse({ error: "No file provided. Use field name 'file'." }, 400);
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return jsonResponse({
        error: `File too large. Max size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`,
      }, 400);
    }

    // Validate mime type
    const mimeType = file.type || guessMimeType(file.name);
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return jsonResponse({
        error: `Unsupported file type: ${mimeType}. Supported: PDF, CSV, XLSX, TXT, JSON, MD, HTML, DOCX.`,
      }, 400);
    }

    // Generate storage path
    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${userId}/${timestamp}_${sanitizedName}`;

    // Upload to Supabase Storage
    const fileBuffer = await file.arrayBuffer();
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, fileBuffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (uploadError) {
      return jsonResponse({
        error: `Upload failed: ${uploadError.message}`,
      }, 500);
    }

    // Create metadata row
    const docId = crypto.randomUUID();
    const { error: insertError } = await supabase.from("documents").insert({
      id: docId,
      user_id: userId,
      filename: file.name,
      mime_type: mimeType,
      size_bytes: file.size,
      storage_path: storagePath,
    });

    if (insertError) {
      // Clean up uploaded file on DB error
      await supabase.storage.from("documents").remove([storagePath]);
      return jsonResponse({
        error: `Failed to save document metadata: ${insertError.message}`,
      }, 500);
    }

    return jsonResponse({
      success: true,
      document: {
        id: docId,
        filename: file.name,
        mime_type: mimeType,
        size_bytes: file.size,
      },
    });

  } catch (err) {
    return jsonResponse({
      error: `Upload processing failed: ${(err as Error).message}`,
    }, 500);
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf",
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    json: "application/json",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[ext || ""] || "application/octet-stream";
}
