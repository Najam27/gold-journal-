import React, { useMemo, useState } from "react";
import { BrainCircuit, CheckCircle2, CircleAlert, ShieldCheck, Sparkles } from "lucide-react";
import { buildTradingEdge, type EdgeTrade } from "@/lib/tradingEdge";

function getLossStreak(trades: EdgeTrade[]) {
  const ordered = [...trades].filter(trade => trade.result !== "OPEN").sort((a: any, b: any) => Number(b.tradeDate ?? 0) - Number(a.tradeDate ?? 0));
  let streak = 0;
  for (const trade of ordered) {
    if (trade.result !== "LOSS") break;
    streak += 1;
  }
  return streak;
}

export function TradingAutomationConsole({ trades }: { trades: EdgeTrade[] }) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem("gj_workflow_automation") !== "off");
  const state = useMemo(() => {
    const closed = trades.filter(trade => trade.result !== "OPEN");
    const edge = buildTradingEdge(trades);
    const lossStreak = getLossStreak(trades);
    const incomplete = closed.filter((trade: any) => !trade.session || !trade.timeframe || !trade.level).length;
    return { closed: closed.length, edge, lossStreak, incomplete };
  }, [trades]);
  const setAutomation = (next: boolean) => { setEnabled(next); localStorage.setItem("gj_workflow_automation", next ? "on" : "off"); };
  const guardrail = state.lossStreak >= 2;
  return <section className="automation-console panel">
    <div className="automation-head"><div><span className="section-label">WORKFLOW AUTOMATION</span><h3>Trade discipline autopilot</h3><p>Real-data prompts update whenever this account’s journal refreshes. They never place trades or change records.</p></div><button className={`automation-toggle ${enabled ? "on" : ""}`} type="button" role="switch" aria-checked={enabled} onClick={() => setAutomation(!enabled)}><i /><span>{enabled ? "ON" : "OFF"}</span></button></div>
    <div className={`automation-grid ${enabled ? "" : "is-off"}`}>
      <article className={`automation-card ${guardrail ? "guard" : "ready"}`}><span className="automation-icon">{guardrail ? <CircleAlert size={17} /> : <ShieldCheck size={17} />}</span><div><small>LOSS GUARDRAIL</small><strong>{guardrail ? `Pause after ${state.lossStreak} consecutive losses` : "Risk state is clear"}</strong><p>{guardrail ? "Review the last two executions and write a new plan before taking another position." : "No consecutive-loss alert is active for the latest closed trades."}</p></div></article>
      <article className="automation-card focus"><span className="automation-icon"><BrainCircuit size={17} /></span><div><small>EDGE-ALIGNED FOCUS</small><strong>{state.edge.strongest?.label ?? "Build evidence first"}</strong><p>{state.edge.strongest ? `Your best qualified context has ${state.edge.strongest.winRate.toFixed(0)}% win rate. Prioritize it, but keep risk rules unchanged.` : "Log five closed trades per context before the system promotes a setup."}</p></div></article>
      <article className={`automation-card ${state.incomplete ? "attention" : "ready"}`}><span className="automation-icon">{state.incomplete ? <Sparkles size={17} /> : <CheckCircle2 size={17} />}</span><div><small>JOURNAL QUALITY</small><strong>{state.incomplete ? `${state.incomplete} trade${state.incomplete === 1 ? " needs" : "s need"} context` : "Context capture is complete"}</strong><p>{state.incomplete ? "Add session, timeframe, and level to sharpen the automated edge comparisons." : `${state.closed} closed trades are ready for context automation.`}</p></div></article>
    </div>
  </section>;
}
