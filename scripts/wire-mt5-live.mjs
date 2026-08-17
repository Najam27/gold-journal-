import { readFileSync, writeFileSync } from "node:fs";

const path = "client/src/pages/GoldJournal.tsx";
let source = readFileSync(path, "utf8");

const replacements = [
  [
    'import { AnalysisEdge } from "@/components/AnalysisEdge";',
    'import { AnalysisEdge } from "@/components/AnalysisEdge";\nimport { Mt5LiveView } from "@/components/Mt5LiveView";'
  ],
  [
    'type View = "trades" | "missed" | "analysis" | "goals" | "calendar" | "plan" | "mentor" | "options";',
    'type View = "trades" | "missed" | "analysis" | "goals" | "calendar" | "plan" | "mentor" | "mt5" | "options";'
  ],
  [
    'emotionBefore: string; emotionDuring: string; emotionAfter: string };',
    'emotionBefore: string; emotionDuring: string; emotionAfter: string; mt5Ticket: string };'
  ],
  [
    '{ id: "mentor", label: "AI Mentor", icon: Bot }, { id: "options", label: "Options", icon: Settings2 },',
    '{ id: "mentor", label: "AI Mentor", icon: Bot }, { id: "mt5", label: "MT5 Live", icon: Wifi }, { id: "options", label: "Options", icon: Settings2 },'
  ],
  [
    'emotionBefore: "", emotionDuring: "", emotionAfter: "" };',
    'emotionBefore: "", emotionDuring: "", emotionAfter: "", mt5Ticket: "" };'
  ],
  [
    'const tradeListInput = useMemo(() => accountId ?',
    'const mt5WorkspaceInput = useMemo(() => accountId ? ({ accountId }) : undefined, [accountId]); const mt5Workspace = trpc.mt5.workspace.useQuery(mt5WorkspaceInput!, { enabled: Boolean(isAuthenticated && mt5WorkspaceInput && (view === "trades" || view === "mt5")), refetchInterval: view === "trades" || view === "mt5" ? 2_500 : false, refetchOnWindowFocus: true }); const tradeListInput = useMemo(() => accountId ?'
  ],
  [
    'risk: source.risk ?? "", reward: source.reward ?? "", pnl: "", patienceScore: source.patienceScore ? String(source.patienceScore) : ""',
    'risk: source.risk ?? "", reward: source.reward ?? "", pnl: source.pnl ?? "", patienceScore: source.patienceScore ? String(source.patienceScore) : "", mt5Ticket: source.mt5Ticket ?? ""'
  ],
  [
    'emotionBefore: trade.emotionBefore || "", emotionDuring: trade.emotionDuring || "", emotionAfter: trade.emotionAfter || "" });',
    'emotionBefore: trade.emotionBefore || "", emotionDuring: trade.emotionDuring || "", emotionAfter: trade.emotionAfter || "", mt5Ticket: trade.mt5Ticket ? String(trade.mt5Ticket) : "" });'
  ],
  [
    'emotionBefore: tradeForm.emotionBefore, emotionDuring: tradeForm.emotionDuring, emotionAfter: tradeForm.emotionAfter };',
    'emotionBefore: tradeForm.emotionBefore, emotionDuring: tradeForm.emotionDuring, emotionAfter: tradeForm.emotionAfter, mt5Ticket: tradeForm.mt5Ticket || undefined };'
  ],
  [
    'dangerGoals={dangerGoals} search={search}',
    'dangerGoals={dangerGoals} mt5LivePositions={mt5Workspace.data?.openPositions ?? []} hasMt5Connection={(mt5Workspace.data?.connections?.length ?? 0) > 0} search={search}'
  ],
  [
    '{view === "mentor" && <MentorView trades={trades} stats={stats} account={account} />}{view === "options"',
    '{view === "mentor" && <MentorView trades={trades} stats={stats} account={account} />}{view === "mt5" && <Mt5LiveView account={account} accounts={data?.accounts ?? []} onJournalNow={(position: any) => openNewTrade({ direction: position.direction, risk: String(position.riskUsd ?? ""), reward: String(position.rewardUsd ?? ""), pnl: String(position.realizedPnl ?? ""), result: position.result, mt5Ticket: position.ticket, notes: "MT5 trade auto-filled. Add your analysis details below." })} />}{view === "options"'
  ]
];

for (const [needle, replacement] of replacements) {
  if (!source.includes(needle)) throw new Error(`Missing expected source fragment: ${needle.slice(0, 80)}`);
  source = source.replace(needle, replacement);
}

writeFileSync(path, source);
