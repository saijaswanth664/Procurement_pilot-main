import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  DEFAULT_DEMAND,
  type Supplier,
  baselineBlob,
  optimizeCategory,
  pctImpr,
  pickLabel,
  qtyNamed,
} from "./optimize.ts";
import { applyShock, cloneSupplier, makeBookable } from "./shock.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function stdOf(unc: Record<string, { std?: number }> | null | undefined, key: string): number {
  return Number(unc?.[key]?.std ?? 0);
}

function rowToSupplier(f: Record<string, unknown>, s: Record<string, unknown>): Supplier {
  const unc = (f.uncertainty ?? {}) as Record<string, { std?: number }>;
  const maxCap = Number(s.max_capacity);
  const util = Number(f.predicted_capacity_util);
  const moq = Number(s.moq);
  const available = Math.max(0, maxCap * (1 - Math.min(Math.max(util, 0), 0.999)));
  return {
    id: Number(s.id),
    name: String(s.name),
    category: String(s.category),
    moq,
    max_capacity: maxCap,
    predicted_price: Number(f.predicted_price),
    predicted_lead_time: Number(f.predicted_lead_time),
    predicted_defect_rate: Number(f.predicted_defect_rate),
    predicted_capacity_util: util,
    predicted_reliability: Number(f.predicted_reliability),
    lead_std: stdOf(unc, "lead_time"),
    defect_std: stdOf(unc, "defect_rate"),
    util_std: stdOf(unc, "capacity_util"),
    uncertainty: unc,
    available,
    unit_risk: 0,
    open: available + 1e-9 >= moq,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData.user) return json({ error: "unauthorized" }, 401);

    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profErr) throw profErr;
    if (profile?.role !== "business_owner") {
      return json({ error: "business_owner role required" }, 403);
    }

    const body = await req.json();
    const supplierId = Number(body.supplier_id);
    const dtype = String(body.type);
    const magnitude = Number(body.magnitude);
    const prepareBookable = Boolean(body.prepare_bookable);
    const compareLabel = String(body.compare_label ?? "cost_aggressive");
    const demandMap = { ...DEFAULT_DEMAND, ...(body.demand ?? {}) };
    if (!supplierId || !dtype || Number.isNaN(magnitude)) {
      return json({ error: "supplier_id, type, magnitude required" }, 400);
    }

    const { data: suppliersRows, error: sErr } = await supabase.from("suppliers").select("*");
    if (sErr) throw sErr;
    const { data: forecastRows, error: fErr } = await supabase
      .from("supplier_forecasts")
      .select("*")
      .order("generated_at", { ascending: false });
    if (fErr) throw fErr;

    const latest = new Map<number, Record<string, unknown>>();
    for (const f of forecastRows ?? []) {
      const sid = Number(f.supplier_id);
      if (!latest.has(sid)) latest.set(sid, f as Record<string, unknown>);
    }
    const bySup = new Map((suppliersRows ?? []).map((r) => [Number(r.id), r as Record<string, unknown>]));
    let pool: Supplier[] = [];
    for (const [sid, f] of latest) {
      const srow = bySup.get(sid);
      if (!srow) continue;
      pool.push(rowToSupplier(f, srow));
    }

    const target0 = pool.find((s) => s.id === supplierId);
    if (!target0) return json({ error: `unknown supplier_id ${supplierId}` }, 404);
    const category = target0.category;
    const demand = Number(demandMap[category] ?? DEFAULT_DEMAND[category]);

    pool = pool.map((s) => cloneSupplier(s));
    let target = pool.find((s) => s.id === supplierId)!;
    if (prepareBookable) {
      const opened = makeBookable(target, demand);
      pool = pool.map((s) => (s.id === supplierId ? opened : s));
      target = opened;
    }

    const beforeGroup = pool.filter((s) => s.category === category);
    const { solved: solvedB } = optimizeCategory(beforeGroup, demand);
    const beforeAlloc = pickLabel(solvedB, compareLabel);

    const shocked = applyShock(target, dtype, magnitude);
    const afterPool = pool.map((s) => (s.id === supplierId ? shocked : s));
    const afterGroup = afterPool.filter((s) => s.category === category);
    const { solved: solvedA, single, even } = optimizeCategory(afterGroup, demand);
    const afterAlloc = pickLabel(solvedA, compareLabel);

    const beforeQty = qtyNamed(beforeAlloc, beforeGroup);
    const afterQty = qtyNamed(afterAlloc, afterGroup);
    const runId = crypto.randomUUID();

    const decisionText =
      `${dtype} disruption ${magnitude}% on ${target.name} (supplier_id=${supplierId}); re-planned ${category} (${compareLabel}).`;
    const reasoning =
      `Shock type=${dtype}, magnitude=${magnitude}% (percent). ` +
      `Forecast util ${target.predicted_capacity_util.toFixed(4)} → ${shocked.predicted_capacity_util.toFixed(4)}, ` +
      `price ${target.predicted_price.toFixed(4)} → ${shocked.predicted_price.toFixed(4)}, ` +
      `defect ${target.predicted_defect_rate.toFixed(5)} → ${shocked.predicted_defect_rate.toFixed(5)}, ` +
      `lead ${target.predicted_lead_time.toFixed(3)} → ${shocked.predicted_lead_time.toFixed(3)}, ` +
      `available ${target.available.toFixed(1)} → ${shocked.available.toFixed(1)} ` +
      `(open ${target.open} → ${shocked.open}). ` +
      `Before ${compareLabel}: cost=${beforeAlloc.expected_cost.toFixed(2)} risk=${beforeAlloc.expected_risk.toFixed(4)} qty=${JSON.stringify(beforeQty)}. ` +
      `After ${compareLabel}: cost=${afterAlloc.expected_cost.toFixed(2)} risk=${afterAlloc.expected_risk.toFixed(4)} qty=${JSON.stringify(afterQty)}. ` +
      `Delta cost=${(afterAlloc.expected_cost - beforeAlloc.expected_cost).toFixed(2)}, ` +
      `delta risk=${(afterAlloc.expected_risk - beforeAlloc.expected_risk).toFixed(4)}.`;

    const { data: disruption, error: dErr } = await supabase
      .from("disruptions")
      .insert({
        supplier_id: supplierId,
        type: dtype,
        magnitude,
        run_id: runId,
      })
      .select("id")
      .single();
    if (dErr) throw dErr;

    const latestF = latest.get(supplierId)!;
    const { error: fcErr } = await supabase.from("supplier_forecasts").insert({
      supplier_id: supplierId,
      forecast_date: latestF.forecast_date,
      horizon_days: latestF.horizon_days ?? 14,
      predicted_price: shocked.predicted_price,
      predicted_reliability: shocked.predicted_reliability,
      predicted_lead_time: shocked.predicted_lead_time,
      predicted_defect_rate: shocked.predicted_defect_rate,
      predicted_capacity_util: shocked.predicted_capacity_util,
      model_type: `${latestF.model_type}+${dtype}_shock`,
      uncertainty: shocked.uncertainty,
      disruption_id: disruption.id,
    });
    if (fcErr) throw fcErr;

    const beforeBlob = {
      label: beforeAlloc.label,
      qty: beforeQty,
      expected_cost: beforeAlloc.expected_cost,
      expected_risk: beforeAlloc.expected_risk,
      status: beforeAlloc.status,
      util: target.predicted_capacity_util,
      available: target.available,
      open: target.open,
    };
    const afterBlob = {
      label: afterAlloc.label,
      qty: afterQty,
      expected_cost: afterAlloc.expected_cost,
      expected_risk: afterAlloc.expected_risk,
      status: afterAlloc.status,
      util: shocked.predicted_capacity_util,
      available: shocked.available,
      open: shocked.open,
    };

    const strategyRows = solvedA
      .filter((a) => a.status === "Optimal")
      .map((a) => ({
        run_id: runId,
        risk_weight: a.risk_weight,
        expected_cost: a.expected_cost,
        expected_risk: a.expected_risk,
        allocation_json: {
          run_id: runId,
          label: a.label,
          category,
          demand,
          risk_weight: a.risk_weight,
          solver: "subset_enum",
          status: a.status,
          objective: a.notes,
          expected_cost: a.expected_cost,
          expected_risk: a.expected_risk,
          disruption: { supplier_id: supplierId, type: dtype, magnitude, run_id: runId },
          before: beforeBlob,
          after: afterBlob,
          suppliers: Object.entries(a.qty).map(([id, qty]) => {
            const sup = afterGroup.find((x) => x.id === Number(id))!;
            return {
              id: Number(id),
              name: sup.name,
              qty,
              predicted_price: sup.predicted_price,
              unit_risk: sup.unit_risk,
              available: sup.available,
              moq: sup.moq,
            };
          }),
          baselines: {
            single_cheapest: baselineBlob(single, afterGroup),
            even_split: baselineBlob(even, afterGroup),
          },
          improvement_pct: {
            cost_vs_single: pctImpr(a.expected_cost, single.expected_cost),
            risk_vs_single: pctImpr(a.expected_risk, single.expected_risk),
            cost_vs_even: pctImpr(a.expected_cost, even.expected_cost),
            risk_vs_even: pctImpr(a.expected_risk, even.expected_risk),
          },
        },
      }));
    if (strategyRows.length) {
      const { error: stErr } = await supabase.from("strategies").insert(strategyRows);
      if (stErr) throw stErr;
    }

    const { error: decErr } = await supabase.from("decisions").insert({
      related_entity_type: "disruption",
      related_entity_id: disruption.id,
      decision_text: decisionText,
      reasoning,
      made_by: "agent",
    });
    if (decErr) throw decErr;

    return json({
      run_id: runId,
      disruption_id: disruption.id,
      before: beforeBlob,
      after: afterBlob,
      decision_text: decisionText,
      reasoning,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 400);
  }
});
