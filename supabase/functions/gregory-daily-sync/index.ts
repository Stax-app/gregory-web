import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FMP_API_KEY = Deno.env.get("FMP_API_KEY")!;
const FMP_BASE_URL = Deno.env.get("FMP_BASE_URL") || "https://financialmodelingprep.com/api";
const CONGRESS_GOV_API_KEY = Deno.env.get("CONGRESS_GOV_API_KEY")!;
const FEC_API_KEY = Deno.env.get("FEC_API_KEY")!;
const LDA_API_KEY = Deno.env.get("LDA_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- HELPERS ----------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJSON(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function createSyncLog(syncType: string): Promise<string> {
  const { data, error } = await supabase
    .from("gregory_sync_logs")
    .insert({ sync_type: syncType, status: "running" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function completeSyncLog(
  id: string,
  status: string,
  processed: number,
  failed: number,
  errors: any[] = []
) {
  await supabase
    .from("gregory_sync_logs")
    .update({
      status,
      records_processed: processed,
      records_failed: failed,
      error_details: errors,
      completed_at: new Date().toISOString(),
    })
    .eq("id", id);
}

async function getOrCreateEntity(
  entityType: string,
  name: string,
  symbol?: string,
  meta?: Record<string, any>,
  source?: string,
  tier?: number
): Promise<string> {
  let query = supabase
    .from("gregory_entities")
    .select("id")
    .eq("entity_type", entityType)
    .eq("name", name);
  if (symbol) query = query.eq("symbol", symbol);

  const { data: existing } = await query.limit(1).single();
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from("gregory_entities")
    .insert({
      entity_type: entityType,
      name,
      symbol: symbol || null,
      metadata: meta || {},
      source: source || "gregory-daily-sync",
      evidence_tier: tier || 3,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

// ---------- FMP SYNC ----------

async function syncFMP(): Promise<{ processed: number; failed: number; errors: any[] }> {
  let processed = 0;
  let failed = 0;
  const errors: any[] = [];

  try {
    const { data: companies, error: compErr } = await supabase
      .from("companies")
      .select("symbol, company_name, sector, industry")
      .eq("is_actively_trading", true)
      .limit(50);

    if (compErr || !companies?.length) {
      return { processed: 0, failed: 0, errors: [{ msg: "No companies found or error", compErr }] };
    }

    const symbols = companies.map((c: any) => c.symbol).join(",");
    const quotes = await fetchJSON(
      `${FMP_BASE_URL}/v3/quote/${symbols}?apikey=${FMP_API_KEY}`
    );

    for (const q of quotes) {
      try {
        const comp = companies.find((c: any) => c.symbol === q.symbol);
        const entityId = await getOrCreateEntity(
          "company",
          comp?.company_name || q.name || q.symbol,
          q.symbol,
          { sector: comp?.sector, industry: comp?.industry },
          "FMP API",
          3
        );

        await supabase.from("gregory_observations").insert({
          entity_id: entityId,
          metric_type: "stock_price",
          metric_value: q.price,
          unit: "USD",
          numeric_status: "REPORTED",
          method_type: "real-time market data",
          source: "Financial Modeling Prep API",
          time_window_start: today(),
          time_window_end: today(),
          confidence: "HIGH",
        });

        if (q.marketCap) {
          await supabase.from("gregory_observations").insert({
            entity_id: entityId,
            metric_type: "market_cap",
            metric_value: q.marketCap,
            unit: "USD",
            numeric_status: "REPORTED",
            method_type: "real-time market data",
            source: "Financial Modeling Prep API",
            time_window_start: today(),
            time_window_end: today(),
            confidence: "HIGH",
          });
        }

        if (q.volume) {
          await supabase.from("gregory_observations").insert({
            entity_id: entityId,
            metric_type: "trading_volume",
            metric_value: q.volume,
            unit: "shares",
            numeric_status: "REPORTED",
            method_type: "real-time market data",
            source: "Financial Modeling Prep API",
            time_window_start: today(),
            time_window_end: today(),
            confidence: "HIGH",
          });
        }

        if (Math.abs(q.changesPercentage) > 3) {
          await supabase.from("gregory_claims").insert({
            entity_id: entityId,
            claim_text: `${q.symbol} moved ${q.changesPercentage > 0 ? "+" : ""}${q.changesPercentage.toFixed(2)}% to $${q.price.toFixed(2)} on ${today()}.`,
            numeric_status: "REPORTED",
            source: "Financial Modeling Prep API — real-time quote",
            source_method: "Market data feed",
            evidence_tier: 2,
            confidence: "HIGH",
            claim_date: today(),
            expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
          });
        }
        processed++;
      } catch (e: any) {
        failed++;
        errors.push({ symbol: q.symbol, error: e.message });
      }
    }
  } catch (e: any) {
    errors.push({ phase: "fmp_batch", error: e.message });
  }

  return { processed, failed, errors };
}

// ---------- CONGRESS.GOV SYNC ----------

async function syncCongress(): Promise<{ processed: number; failed: number; errors: any[] }> {
  let processed = 0;
  let failed = 0;
  const errors: any[] = [];

  try {
    const res = await fetchJSON(
      `https://api.congress.gov/v3/bill?format=json&limit=20&sort=updateDate+desc&api_key=${CONGRESS_GOV_API_KEY}`
    );
    const bills = res.bills || [];

    for (const bill of bills) {
      try {
        const billName = `${bill.type || ""}.${bill.number || ""} — ${bill.title || "Untitled"}`;
        const entityId = await getOrCreateEntity(
          "policy",
          billName,
          undefined,
          {
            congress: bill.congress,
            bill_type: bill.type,
            bill_number: bill.number,
            latest_action: bill.latestAction,
            origin_chamber: bill.originChamber,
            url: bill.url,
          },
          "Congress.gov API",
          1
        );

        const actionText = bill.latestAction?.text || "No action recorded";
        const actionDate = bill.latestAction?.actionDate || today();

        await supabase.from("gregory_claims").insert({
          entity_id: entityId,
          claim_text: `${billName}: ${actionText} (${actionDate}).`,
          numeric_status: "REPORTED",
          source: `Congress.gov API — congress ${bill.congress}`,
          source_method: "Official legislative record",
          evidence_tier: 1,
          confidence: "HIGH",
          claim_date: actionDate,
          expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        });

        processed++;
      } catch (e: any) {
        failed++;
        errors.push({ bill: bill.number, error: e.message });
      }
    }
  } catch (e: any) {
    errors.push({ phase: "congress_fetch", error: e.message });
  }

  return { processed, failed, errors };
}

// ---------- FEC SYNC ----------

async function syncFEC(): Promise<{ processed: number; failed: number; errors: any[] }> {
  let processed = 0;
  let failed = 0;
  const errors: any[] = [];

  try {
    const currentYear = new Date().getFullYear();
    const cycle = currentYear % 2 === 0 ? currentYear : currentYear - 1;

    const res = await fetchJSON(
      `https://api.open.fec.gov/v1/candidates/?sort=-receipts&per_page=20&cycle=${cycle}&api_key=${FEC_API_KEY}`
    );
    const candidates = res.results || [];

    for (const c of candidates) {
      try {
        const entityId = await getOrCreateEntity(
          "campaign",
          `${c.name} (${c.party_full || c.party || "Unknown"})`,
          undefined,
          {
            candidate_id: c.candidate_id,
            party: c.party_full || c.party,
            office: c.office_full || c.office,
            state: c.state,
            cycle,
            incumbent_challenge: c.incumbent_challenge_full,
          },
          "FEC API",
          1
        );

        if (c.receipts) {
          await supabase.from("gregory_observations").insert({
            entity_id: entityId,
            metric_type: "campaign_receipts",
            metric_value: c.receipts,
            unit: "USD",
            numeric_status: "REPORTED",
            method_type: "FEC filing",
            source: "Federal Election Commission API",
            time_window_start: `${cycle - 1}-01-01`,
            time_window_end: today(),
            confidence: "HIGH",
          });
        }

        if (c.disbursements) {
          await supabase.from("gregory_observations").insert({
            entity_id: entityId,
            metric_type: "campaign_disbursements",
            metric_value: c.disbursements,
            unit: "USD",
            numeric_status: "REPORTED",
            method_type: "FEC filing",
            source: "Federal Election Commission API",
            time_window_start: `${cycle - 1}-01-01`,
            time_window_end: today(),
            confidence: "HIGH",
          });
        }

        processed++;
      } catch (e: any) {
        failed++;
        errors.push({ candidate: c.name, error: e.message });
      }
    }
  } catch (e: any) {
    errors.push({ phase: "fec_fetch", error: e.message });
  }

  return { processed, failed, errors };
}

// ---------- LDA SYNC ----------

async function syncLDA(): Promise<{ processed: number; failed: number; errors: any[] }> {
  let processed = 0;
  let failed = 0;
  const errors: any[] = [];

  try {
    const currentYear = new Date().getFullYear();
    let filings: any[] = [];

    for (const year of [currentYear, currentYear - 1]) {
      try {
        const res = await fetchJSON(
          `https://lda.senate.gov/api/v1/filings/?filing_year=${year}&ordering=-dt_posted&page_size=20`
        );
        filings = res.results || [];
        if (filings.length > 0) break;
      } catch {
        continue;
      }
    }

    for (const f of filings) {
      try {
        const registrantName = f.registrant?.name || "Unknown Registrant";
        const clientName = f.client?.name || "Unknown Client";

        const entityId = await getOrCreateEntity(
          "company",
          registrantName,
          undefined,
          {
            lda_registrant_id: f.registrant?.id,
            type: "lobbying_firm",
          },
          "LDA API",
          1
        );

        const incomeStr = f.income
          ? `Income: $${Number(f.income).toLocaleString()}.`
          : "Income: not reported.";

        await supabase.from("gregory_claims").insert({
          entity_id: entityId,
          claim_text: `${registrantName} filed lobbying disclosure for client ${clientName}. ${incomeStr} Filing period: ${f.filing_period || "quarterly"} ${f.filing_year || currentYear}.`,
          numeric_status: f.income ? "REPORTED" : "UNKNOWN",
          source: "LDA Senate API — lobbying disclosure filing",
          source_method: "Official LDA filing",
          evidence_tier: 1,
          confidence: "HIGH",
          claim_date: f.dt_posted?.slice(0, 10) || today(),
          expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
        });

        if (f.income) {
          await supabase.from("gregory_observations").insert({
            entity_id: entityId,
            metric_type: "lobbying_income",
            metric_value: Number(f.income),
            unit: "USD",
            numeric_status: "REPORTED",
            method_type: "LDA filing",
            source: "LDA Senate API",
            time_window_start: `${f.filing_year || currentYear}-01-01`,
            time_window_end: today(),
            geography: "US",
            confidence: "HIGH",
          });
        }

        processed++;
      } catch (e: any) {
        failed++;
        errors.push({ filing: f.id, error: e.message });
      }
    }
  } catch (e: any) {
    errors.push({ phase: "lda_fetch", error: e.message });
  }

  return { processed, failed, errors };
}

// ---------- MAIN HANDLER ----------

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  const masterLogId = await createSyncLog("full_daily");
  const results: Record<string, any> = {};

  // 1. FMP Sync
  const fmpLogId = await createSyncLog("fmp");
  try {
    const fmpResult = await syncFMP();
    results.fmp = fmpResult;
    await completeSyncLog(fmpLogId, "completed", fmpResult.processed, fmpResult.failed, fmpResult.errors);
  } catch (e: any) {
    results.fmp = { error: e.message };
    await completeSyncLog(fmpLogId, "failed", 0, 0, [{ error: e.message }]);
  }
  await sleep(1000);

  // 2. Congress.gov Sync
  const congressLogId = await createSyncLog("congress");
  try {
    const congressResult = await syncCongress();
    results.congress = congressResult;
    await completeSyncLog(congressLogId, "completed", congressResult.processed, congressResult.failed, congressResult.errors);
  } catch (e: any) {
    results.congress = { error: e.message };
    await completeSyncLog(congressLogId, "failed", 0, 0, [{ error: e.message }]);
  }
  await sleep(1000);

  // 3. FEC Sync
  const fecLogId = await createSyncLog("fec");
  try {
    const fecResult = await syncFEC();
    results.fec = fecResult;
    await completeSyncLog(fecLogId, "completed", fecResult.processed, fecResult.failed, fecResult.errors);
  } catch (e: any) {
    results.fec = { error: e.message };
    await completeSyncLog(fecLogId, "failed", 0, 0, [{ error: e.message }]);
  }
  await sleep(1000);

  // 4. LDA Sync
  const ldaLogId = await createSyncLog("lda");
  try {
    const ldaResult = await syncLDA();
    results.lda = ldaResult;
    await completeSyncLog(ldaLogId, "completed", ldaResult.processed, ldaResult.failed, ldaResult.errors);
  } catch (e: any) {
    results.lda = { error: e.message };
    await completeSyncLog(ldaLogId, "failed", 0, 0, [{ error: e.message }]);
  }

  // Complete master log
  const totalProcessed = Object.values(results).reduce(
    (sum: number, r: any) => sum + (r.processed || 0), 0
  );
  const totalFailed = Object.values(results).reduce(
    (sum: number, r: any) => sum + (r.failed || 0), 0
  );
  await completeSyncLog(
    masterLogId,
    totalFailed > totalProcessed ? "failed" : "completed",
    totalProcessed,
    totalFailed
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  return new Response(
    JSON.stringify({
      status: "completed",
      duration_seconds: elapsed,
      total_processed: totalProcessed,
      total_failed: totalFailed,
      details: results,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Connection: "keep-alive",
      },
    }
  );
});
