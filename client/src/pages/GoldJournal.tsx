import DOMPurify from "dompurify";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  executionTypes,
  formatDate,
  formatMoney,
  formatRr,
  getPktDateInput,
  getPktSession,
  isFuturePktDate,
  levels,
  results,
  sessions,
  toNumber,
} from "@/lib/gold";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { getAuthRedirectUrl } from "@/lib/authRedirect";
import { supabase } from "@/lib/supabase";
import {
  getSelectedAccountId,
  setSelectedAccountId,
  subscribeSelectedAccount,
} from "@/lib/accountSelection";
import {
  JOURNAL_VIEW_EVENT,
  openJournalView,
  type JournalViewTarget,
} from "@/lib/journalViewNavigation";
import { beginAccountSwitchForApp, invalidateAccountScopedQueries, payloadBelongsToAccount, refreshCurrentAccount, resolveActiveAccount } from "@/lib/accountScope";
import { classifyApiError } from "@/lib/apiErrors";
import { JournalQueryError, SwitchingAccount } from "@/components/QueryError";
import { AccountStatusStrip } from "@/components/premium/AccountStatusStrip";
import { AmbientField } from "@/components/premium/AmbientField";
import { Premium3DBackground } from "@/components/premium/Premium3DBackground";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useIsDrawerNav } from "@/hooks/useMobile";
import { OFFLINE_CASH_REQUEST_EVENT } from "@/lib/offlineMutationQueue";
import { useLocalJournal } from "@/lib/journal/useLocalJournal";
import { JOURNAL_LOCAL_EVENT } from "@/lib/journal/journalStore";
import {
  isOnline,
  queuedJournalMutationCount,
  type JournalMutation,
  type JournalSyncState,
} from "@/lib/journal/journalSync";
import { PlanExecutionEditor } from "@/components/PlanExecutionEditor";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TradeLogWithViewer } from "@/components/TradeLogWithViewer";
import { TradeDialogWithCustomOptions } from "@/components/TradeDialogWithCustomOptions";
import { PnlCalendarWithWeeks } from "@/components/PnlCalendarWithWeeks";
import { FlexibleGoalsView } from "@/components/FlexibleGoalsView";
import { TraderDevelopmentPanel } from "@/components/TraderDevelopmentPanel";
import { SessionRecovery } from "@/components/SessionRecovery";
import { Mt5LiveView } from "@/components/Mt5LiveView";
import { UserAiProviderSettings } from "@/components/UserAiProviderSettings";
import { Field, RiskMetric } from "@/components/journalPrimitives";
import { RiskCalculatorPanel } from "@/components/RiskCalculatorPanel";
import {
  AI_UI_COPY,
  analyzeJournal,
  type AiAnalysisOutcome,
} from "@/lib/ai/aiService";
import { uiStateForErrorCode, type AiUiState } from "@/lib/ai/aiTypes";
import { useAiSettings } from "@/lib/ai/useAiSettings";
import type { AnalysisResult } from "@shared/analysisEngine";
import { MissedTradesView } from "@/components/MissedTradesView";
import { GoldCanvas } from "@/components/three/GoldCanvas";
import { useGsapTimeline } from "@/lib/motion/gsap";
import { gsap } from "gsap";
import { NotificationCenter } from "@/components/NotificationCenter";
import { AccountRenameControl } from "@/components/AccountRenameControl";
import { OptionListManager } from "@/components/OptionListManager";
import { TradeOptionManager } from "@/components/TradeOptionManager";
import { BulkPdfExporter } from "@/components/BulkPdfExporter";
import { assessTraderGoal } from "@/lib/traderGoals";
import { behaviorConfigFromProfile, buildTraderDevelopment, PRE_TRADE_GATE_ITEMS } from "@/lib/psychology";
import { toast } from "sonner";
import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Brain,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDollarSign,
  Cloud,
  Download,
  FileSpreadsheet,
  FileText,
  Goal,
  ImagePlus,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCcw,
  Settings2,
  ShieldAlert,
  Target,
  Trash2,
  Wallet,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";

const logoUrl = "/gold-journal-3d.svg";
const AnalysisDashboardLazy = React.lazy(async () => ({
  default: (await import("@/components/AnalysisDashboard")).AnalysisDashboard,
}));
type View =
  | "trades"
  | "missed"
  | "analysis"
  | "goals"
  | "psychology"
  | "calendar"
  | "plan"
  | "mentor"
  | "mt5"
  | "risk"
  | "options";
type TradeForm = {
  tradeDate: string;
  session: string;
  direction: "" | "BUY" | "SELL";
  result: "" | "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN";
  level: string;
  timeframe: string;
  setupQuality: string;
  executionType: string;
  marketCondition: string;
  biasAlignment: string;
  confirmationType: string;
  slPlacement: string;
  tpPlacement: string;
  mistake: string;
  holdQuality: string;
  patienceScore: string;
  risk: string;
  reward: string;
  pnl: string;
  notes: string;
  emotionBefore: string;
  emotionDuring: string;
  emotionAfter: string;
  /** "" records "not evaluated" for MT5 imports and untouched entries. */
  planStatus: "" | "PLANNED" | "UNPLANNED";
  /** Pipe-separated ids of the confirmed pre-trade checklist items. */
  planChecklist: string;
  mt5Ticket: string;
};

export type AuthGate = "splash" | "auth-error" | "login" | "dashboard";
export function getAuthGate(
  status: "booting" | "authenticated" | "unauthenticated" | "error"
): AuthGate {
  if (status === "booting") return "splash";
  if (status === "error") return "auth-error";
  return status === "authenticated" ? "dashboard" : "login";
}

const navItems: { id: View; label: string; icon: typeof BookOpen }[] = [
  { id: "trades", label: "Trade Log", icon: BookOpen },
  { id: "missed", label: "Missed Trades", icon: Target },
  { id: "analysis", label: "Analysis", icon: BarChart3 },
  { id: "goals", label: "Goals", icon: Goal },
  { id: "psychology", label: "Psychology", icon: Brain },
  { id: "calendar", label: "PnL Calendar", icon: CalendarDays },
  { id: "plan", label: "Plan & Execution", icon: Check },
  { id: "mentor", label: "AI Mentor", icon: Bot },
  { id: "mt5", label: "MT5 Live", icon: CircleDollarSign },
  { id: "risk", label: "Risk Calculator", icon: CircleDollarSign },
  { id: "options", label: "Options", icon: Settings2 },
];
// The phone bottom bar keeps the six destinations a trader opens mid-session.
// Every other view stays reachable from the sidebar drawer.
const mobileNavIds: View[] = ["trades", "analysis", "goals", "psychology", "calendar", "mt5"];
export const JOURNAL_RETRY_EVENT = "gold-journal:retry";
const NAV_GROUP_LABELS: Record<string, string> = { trades: "Journal", missed: "Journal", analysis: "Journal", calendar: "Journal", goals: "Discipline", psychology: "Discipline", plan: "Discipline", mentor: "Intelligence", mt5: "Intelligence", risk: "Intelligence", options: "Workspace" };
const isJournalView = (value: unknown): value is View =>
  navItems.some(item => item.id === value);
const defaultRules = [
  "Maximum 3 trades today. Stop after 3.",
  "Stop trading if daily loss exceeds my limit.",
  "After a loss, wait 30 minutes before next entry.",
  "No chasing moves. Missed entry = wait for next setup.",
  "Only take A or A+ setups today.",
  "Never move SL against the trade once set.",
  "No trades 30 minutes before/after high-impact news.",
  "Take screenshot for every trade. No exceptions.",
];
export const MENTOR_LOCAL_KEY_NOTICE =
  "Your Google AI Studio key stays in this browser only, is never sent to Gold Journal servers or stored with journal data, and is read solely to call Google AI directly from this device.";
export function getMentorStorageKeys(_openId?: string | null) {
  return { storageKey: "", reportStorageKey: "" };
}

const dateInput = getPktDateInput;
export function defaultTrade(): TradeForm {
  return {
    tradeDate: dateInput(),
    session: getPktSession(),
    direction: "",
    result: "",
    level: "",
    timeframe: "",
    setupQuality: "",
    executionType: "",
    marketCondition: "",
    biasAlignment: "",
    confirmationType: "",
    slPlacement: "",
    tpPlacement: "",
    mistake: "",
    holdQuality: "",
    patienceScore: "",
    risk: "",
    reward: "",
    pnl: "",
    notes: "",
    emotionBefore: "",
    emotionDuring: "",
    emotionAfter: "",
    planStatus: "",
    planChecklist: "",
    mt5Ticket: "",
  };
}
function initials(name?: string | null) {
  return (name || "Gold Trader")
    .split(" ")
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .toUpperCase();
}
function sanitize(value?: string | null) {
  return DOMPurify.sanitize(value ?? "", {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
  });
}
function GoldMark({ size = 34 }: { size?: number }) {
  return (
    <div className="gold-mark" style={{ width: size, height: size }}>
      <img src={logoUrl} alt="Gold Journal" />
    </div>
  );
}
function StatCard({
  label,
  value,
  detail,
  tone = "gold",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <div className={`stat-card stat-${tone}`}>
      <p>{label}</p>
      <strong className="data-text">{value}</strong>
      <span>{detail}</span>
    </div>
  );
}
function EmptyState({
  title,
  copy,
  action,
}: {
  title: string;
  copy: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-orbit">
        <GoldMark size={42} />
      </div>
      <h3>{title}</h3>
      <p>{copy}</p>
      {action}
    </div>
  );
}
function FormSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="form-section modal-section">
      <span className="section-label">{title}</span>
      <div className="field-grid">{children}</div>
    </section>
  );
}

export function journalStats(
  trades: any[],
  account: any,
  movements: any[],
  cashNet?: number,
  tradeSummary?: any
) {
  const summaryAvailable = Boolean(
    tradeSummary && tradeSummary.source !== "fallback"
  );
  const summaryNumber = (value: unknown, fallback: number) =>
    summaryAvailable ? toNumber(value) : fallback;
  const wins = summaryNumber(
    tradeSummary?.wins,
    trades.filter(trade => trade.result === "WIN").length
  );
  const closed = summaryNumber(
    tradeSummary?.closed,
    trades.filter(trade => trade.result !== "OPEN").length
  );
  const pnl = summaryNumber(
    tradeSummary?.pnl,
    trades.reduce((total, trade) => total + toNumber(trade.pnl), 0)
  );
  const total = summaryNumber(tradeSummary?.total, trades.length);
  const losses = summaryNumber(
    tradeSummary?.losses,
    trades.filter(trade => trade.result === "LOSS").length
  );
  const cash =
    cashNet ??
    movements.reduce(
      (total, item) =>
        total +
        (item.type === "DEPOSIT"
          ? toNumber(item.amount)
          : -toNumber(item.amount)),
      0
    );
  return {
    total,
    wins,
    losses,
    pnl,
    balance: toNumber(account?.startingBalance) + pnl + cash,
    winRate: closed ? (wins / closed) * 100 : 0,
  };
}
function goalState(goal: any, trades: any[]) {
  const entry = assessTraderGoal(goal, trades, []);
  return {
    value: entry.value,
    target: entry.target,
    status: entry.status === "AT_RISK" ? "AT RISK" : entry.status,
    percentage: entry.percentage,
  };
}

export default function GoldJournal() {
  const {
    user,
    session,
    status: authStatus,
    isAuthenticated,
    profileReady,
    profileLoading,
    authError,
    authMeError,
    refresh: authRefresh,
    retryBootstrap,
    reconnect,
    logout,
  } = useAuth();
  const authUserId = session?.user?.id ?? null;
  const previousAuthUserId = useRef<string | null | undefined>(undefined);
  const [view, setView] = useState<View>("trades");
  const [mobileNav, setMobileNav] = useState(false);
  /**
   * Rail state is chrome, not app state, so it is remembered per device. Above
   * 1024px it folds the sidebar to the icon rail; below that the sidebar is an
   * off-canvas drawer and `mobileNav` owns open/closed instead.
   */
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("gj:sidebar-rail") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("gj:sidebar-rail", collapsed ? "1" : "0");
    } catch {
      /* Storage can be unavailable (private mode); the rail then just resets. */
    }
  }, [collapsed]);
  /**
   * The drawer is a real overlay: Escape closes it and the page behind it must
   * not scroll, otherwise a swipe on the phone scrolls the journal underneath
   * the menu instead of the menu itself.
   */
  useEffect(() => {
    if (!mobileNav) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNav(false);
    };
    // Widening past the drawer breakpoint (or rotating a tablet) must not leave
    // the page holding a scroll lock behind a scrim that is no longer drawn.
    const closeOnWideViewport = () => {
      if (window.innerWidth >= 1024) setMobileNav(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeOnWideViewport);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeOnWideViewport);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileNav]);
  /**
   * Account-switch transaction state.
   *
   * `switchPending` is true from the moment a switch starts until the FIRST
   * (critical) read for the newly selected account has settled. Only that read
   * runs during the switch; MT5, analysis, notifications, and the other
   * secondary surfaces mount afterwards, so a switch can never fire a dozen
   * heavy requests at once (which is what timed out the Trade Log).
   *
   * `switchTargetRef` dedupes the re-entrant selection events that a published
   * selection triggers before React re-renders.
   */
  const [switchPending, setSwitchPending] = useState(false);
  const switchTargetRef = useRef<number | undefined>(undefined);
  const mt5ReconcileRef = useRef<{ busy: boolean; at: number }>({ busy: false, at: 0 });
  const [accountId, setAccountId] = useState<number | undefined>(() =>
    getSelectedAccountId()
  );
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [installEvent, setInstallEvent] = useState<any>();
  const [installHelp, setInstallHelp] = useState(false);
  const [tradeDialog, setTradeDialog] = useState(false);
  const [tradeForm, setTradeForm] = useState<TradeForm>(defaultTrade());
  const [editing, setEditing] = useState<any>();
  const [screenshot, setScreenshot] = useState<File>();
  const [uploadProgress, setUploadProgress] = useState(0);
  const [cashDialog, setCashDialog] = useState<"DEPOSIT" | "WITHDRAW" | null>(
    null
  );
  const [cashAmount, setCashAmount] = useState("");
  const [cashNote, setCashNote] = useState("");
  const [search, setSearch] = useState("");
  const [resultFilter, setResultFilter] = useState("ALL");
  const [tradePage, setTradePage] = useState(1);
  // Typing must not fire a filtered server read on every keystroke: the input
  // stays instant and the trade-list query follows a short pause.
  const debouncedSearch = useDebouncedValue(search, 250);
  const [missedDialog, setMissedDialog] = useState(false);
  useEffect(() => {
    const navigate = (event: Event) => {
      const next = (event as CustomEvent<{ view?: JournalViewTarget }>).detail
        ?.view;
      if (!isJournalView(next)) return;
      setView(next);
      setMobileNav(false);
    };
    window.addEventListener(JOURNAL_VIEW_EVENT, navigate);
    return () => window.removeEventListener(JOURNAL_VIEW_EVENT, navigate);
  }, []);
  const accountListQuery = trpc.accounts.list.useQuery(undefined, {
    enabled: profileReady,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const accountBootstrap = trpc.journal.bootstrap.useQuery(undefined, {
    enabled: profileReady && (accountListQuery.data?.length ?? 0) === 0,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const ownedAccounts = accountListQuery.data ?? [];
  const accountSelectionResolved =
    accountListQuery.isSuccess || Boolean(accountBootstrap.data?.id);
  const queryInput = useMemo(() => ({ accountId }), [accountId]);
  // Which read the visible view needs first. Everything else is secondary and
  // waits for it, so switching accounts loads one thing, not eight.
  const criticalView = view === "trades" ? "trades" : view === "mt5" ? "mt5" : "journal";
  const journalIsCritical = criticalView === "journal";
  const mt5IsCritical = criticalView === "mt5";
  // journal.get is the heavy composite read (trades, goal trades, cash
  // movements, goals, skipped trades, plans, profile, plus two aggregates). It
  // feeds stats, goals, plans, and the behavioural report, none of which need a
  // sub-second cadence, so it polls slowly and only while a view shows the
  // derived data. MT5 Live owns its own fast workspace/history polls.
  const journalRefetchInterval = (() => {
    if (view === "trades" || view === "mt5") return 20_000;
    if (view === "goals" || view === "psychology" || view === "calendar") return 120_000;
    return false;
  })();
  const journalQuery = trpc.journal.get.useQuery(queryInput, {
    enabled: Boolean(
      profileReady &&
        accountSelectionResolved &&
        accountId &&
        (journalIsCritical || !switchPending)
    ),
    retry: false,
    refetchInterval: journalRefetchInterval,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
    // Switching accounts keeps the current view on screen and swaps it in when
    // the new account resolves, instead of flashing the full-page loader and
    // looking like the switch did nothing.
    placeholderData: keepPreviousData,
  });
  const mt5WorkspaceInput = useMemo(
    () => (accountId ? { accountId } : undefined),
    [accountId]
  );
  const mt5Workspace = trpc.mt5.workspace.useQuery(mt5WorkspaceInput!, {
    enabled: Boolean(
      profileReady &&
        mt5WorkspaceInput &&
        (view === "trades" || view === "mt5") &&
        (mt5IsCritical || !switchPending)
    ),
    // The Trade Log only surfaces MT5 open positions as a secondary panel, so
    // it does not need the 2.5 s live cadence that the MT5 Live view runs.
    refetchInterval: view === "mt5" ? 2_500 : view === "trades" ? 10_000 : false,
    refetchOnWindowFocus: true,
    staleTime: 2_000,
  });
  const tradeListInput = useMemo(
    () =>
      accountId
        ? {
            accountId,
            page: tradePage,
            pageSize: 12,
            search: debouncedSearch,
            result:
              resultFilter === "ALL"
                ? undefined
                : (resultFilter as "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN"),
          }
        : undefined,
    [accountId, debouncedSearch, tradePage, resultFilter]
  );
  const tradeListQuery = trpc.trades.list.useQuery(tradeListInput!, {
    enabled: Boolean(
      profileReady && tradeListInput && (criticalView === "trades" || !switchPending)
    ),
    refetchInterval: view === "trades" ? 10_000 : false,
    refetchOnWindowFocus: true,
    staleTime: 4_000,
  });
  const utils = trpc.useUtils();
  const createTrade = trpc.trades.create.useMutation();
  const updateTrade = trpc.trades.update.useMutation();
  const deleteTrade = trpc.trades.delete.useMutation();
  const uploadScreenshot = trpc.trades.uploadScreenshot.useMutation();
  const clearAll = trpc.trades.clearAll.useMutation();
  const createCash = trpc.cash.create.useMutation();
  const createGoal = trpc.goals.create.useMutation();
  const updateGoal = trpc.goals.update.useMutation();
  const deleteGoal = trpc.goals.delete.useMutation();
  const clearGoals = trpc.goals.clearAll.useMutation();
  const recordGoalAlerts = trpc.notifications.recordGoalAlerts.useMutation();
  const createAccount = trpc.accounts.create.useMutation();
  // MT5 reconciliation is a WRITE path. It used to run inside journal.get and
  // trades.list (one Supabase round-trip per stored position), which is what
  // made account switches time out; it is now an explicit, bounded, event-driven
  // call that the workspace payload itself triggers.
  const syncMt5TradeLog = trpc.mt5.syncTradeLog.useMutation();
  // Local-first journal runtime. The browser writes locally first, updates the
  // UI immediately, queues the change durably, and syncs with retry/backoff.
  // The backend is the cloud synchronisation and backup layer.
  const localJournal = useLocalJournal({
    accountId,
    subject: authUserId,
    journal: journalQuery.data as Record<string, unknown> | undefined,
    dispatch: async (mutation: JournalMutation) => {
      const payload = mutation.payload as any;
      if (mutation.kind === "trade.create")
        await createTrade.mutateAsync(payload);
      else if (mutation.kind === "trade.update")
        await updateTrade.mutateAsync(payload);
      else if (mutation.kind === "trade.delete")
        await deleteTrade.mutateAsync(payload);
      else if (mutation.kind === "cash.create")
        await createCash.mutateAsync(payload);
    },
    onSynced: () => {
      void invalidateAccountScopedQueries(utils);
    },
  });
  useEffect(() => {
    const up = () => setIsOnline(true);
    const down = () => setIsOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  useEffect(() => {
    if (isOnline) void localJournal.flush();
  }, [isOnline, localJournal.flush]);
  // Event-driven MT5 -> Trade Log reconciliation. The read paths no longer
  // write, so the workspace payload (each position carries `journaled`) is the
  // trigger: unjournaled MT5 positions are reconciled in bounded passes, and the
  // journal/trade list is invalidated only when something actually changed.
  useEffect(() => {
    if (!accountId || switchPending) return;
    const positions = [
      ...(mt5Workspace.data?.openPositions ?? []),
      ...(mt5Workspace.data?.closedPositions ?? []),
    ] as Array<{ journaled?: boolean }>;
    if (!positions.some(position => position?.journaled === false)) return;
    const now = Date.now();
    if (mt5ReconcileRef.current.busy || now - mt5ReconcileRef.current.at < 15_000) return;
    mt5ReconcileRef.current = { busy: true, at: now };
    let canceled = false;
    const drain = async () => {
      let synchronized = 0;
      // Bounded passes: the server caps each call, so a first-time backfill of
      // hundreds of positions drains over a few seconds instead of holding one
      // request open until it times out.
      for (let pass = 0; pass < 5 && !canceled; pass += 1) {
        const result = (await syncMt5TradeLog.mutateAsync({ accountId, limit: 20 })) as
          | { synchronized?: number; remaining?: number }
          | undefined;
        synchronized += Number(result?.synchronized ?? 0);
        if (!result?.remaining) break;
      }
      return synchronized;
    };
    void drain()
      .then(synchronized => {
        if (!canceled && synchronized > 0) refreshCurrentAccount(utils);
      })
      .catch(() => undefined)
      .finally(() => {
        mt5ReconcileRef.current = { busy: false, at: mt5ReconcileRef.current.at };
      });
    return () => {
      canceled = true;
    };
  }, [accountId, mt5Workspace.data, switchPending, syncMt5TradeLog, utils]);
  useEffect(() => {
    const queueCash = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          type?: "DEPOSIT" | "WITHDRAW";
          amount?: number;
          note?: string;
        }>
      ).detail;
      if (
        !accountId ||
        !authUserId ||
        !detail?.type ||
        !Number.isFinite(detail.amount) ||
        (detail.amount ?? 0) <= 0
      )
        return;
      void localJournal.queueMutation({
        kind: "cash.create",
        payload: {
          accountId,
          movementDate: Date.now(),
          type: detail.type,
          amount: detail.amount,
          note: detail.note ?? "",
        },
      });
      setCashDialog(null);
      setCashAmount("");
      setCashNote("");
      toast.success("Cash movement saved locally and queued for sync.");
    };
    window.addEventListener(OFFLINE_CASH_REQUEST_EVENT, queueCash);
    return () =>
      window.removeEventListener(OFFLINE_CASH_REQUEST_EVENT, queueCash);
  }, [accountId, authUserId, localJournal.queueMutation]);
  useEffect(() => {
    const eventHandler = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event);
    };
    window.addEventListener("beforeinstallprompt", eventHandler);
    return () =>
      window.removeEventListener("beforeinstallprompt", eventHandler);
  }, []);
  useEffect(() => {
    if (accountBootstrap.data?.id) void accountListQuery.refetch();
  }, [accountBootstrap.data?.id, accountListQuery.refetch]);
  useEffect(() => {
    if (!profileReady) return;
    const bootstrapAccountId = Number(
      (accountBootstrap.data as { id?: unknown } | undefined)?.id
    );
    const firstOwnedAccountId = Number(
      (ownedAccounts[0] as { id?: unknown } | undefined)?.id
    );
    const valid: number | undefined =
      accountId &&
      ownedAccounts.some((item: any) => Number(item.id) === accountId)
        ? accountId
        : ((Number.isInteger(firstOwnedAccountId) && firstOwnedAccountId > 0
            ? firstOwnedAccountId
            : undefined) ??
          (Number.isInteger(bootstrapAccountId) && bootstrapAccountId > 0
            ? bootstrapAccountId
            : undefined));
    if (valid && valid !== accountId) {
      // The first owned account is a selection, not a user switch: no cache is
      // dropped, but the switch ref must know about it so a later real switch is
      // not deduped away.
      switchTargetRef.current = valid;
      setAccountId(valid);
      setSelectedAccountId(valid);
    } else if (
      !valid &&
      accountListQuery.isSuccess &&
      ownedAccounts.length === 0 &&
      accountBootstrap.isError
    )
      setSelectedAccountId(undefined);
  }, [
    accountBootstrap.data?.id,
    accountBootstrap.isError,
    accountId,
    accountListQuery.isSuccess,
    ownedAccounts,
    profileReady,
  ]);
  useEffect(() => {
    if (
      previousAuthUserId.current !== undefined &&
      previousAuthUserId.current !== authUserId
    ) {
      setAccountId(undefined);
      setSelectedAccountId(undefined);
    }
    previousAuthUserId.current = authUserId;
  }, [authUserId]);
  // Local-first render: fall back to the last local snapshot so a refresh,
  // a cold start, or a temporary backend outage still shows the user's journal.
  // Local-first render: fall back to the last local snapshot so a refresh,
  // a cold start, or a temporary backend outage still shows the user's journal.
  //
  // Account generation guard: a payload that still belongs to the previous
  // account (React Query placeholder data, or a late response) is never rendered
  // as the selected account. This is the client half of "old account data must
  // never reach the new account UI".
  const journalPayload = payloadBelongsToAccount(journalQuery.data, accountId)
    ? (journalQuery.data as any)
    : undefined;
  const localSnapshot = payloadBelongsToAccount(
    localJournal.localSnapshot,
    accountId
  )
    ? (localJournal.localSnapshot as any)
    : undefined;
  const data = journalPayload ?? localSnapshot ?? undefined;
  // The account the UI acts on is always the one the user selected. A server
  // echo for a different id (a previous account kept alive by placeholder data)
  // must never win, because that is what silently reverted a switch. Both the
  // selection and the payload can be unknown on a cold start, so the shared
  // helper never compares a missing selection as though it were an id.
  const account = resolveActiveAccount(
    data?.activeAccount,
    ownedAccounts as { id: number }[],
    accountId
  );
  // Stable references keep the memoised goal assessment and behavioural report
  // from re-running when an unrelated render happens (search typing, view
  // switches, notification polls).
  const trades = useMemo(() => data?.trades ?? [], [data?.trades]);
  const goalTrades = useMemo(() => data?.goalTrades ?? trades, [data?.goalTrades, trades]);
  const cashMovements = useMemo(() => data?.cashMovements ?? [], [data?.cashMovements]);
  const stats = useMemo(
    () => journalStats(trades, account, cashMovements, data?.cashNet, data?.tradeSummary),
    [trades, account, cashMovements, data?.cashNet, data?.tradeSummary]
  );
  const activeMt5Connection = mt5Workspace.data?.connections?.find(
    (connection: any) => connection.active
  );
  // Behavioural layer. One memoised development report is shared by the Goals
  // page, the calendar drill-down, and the cooldown banner, so the expensive
  // pass over the journal never runs during a render.
  const behaviorConfig = useMemo(() => behaviorConfigFromProfile((data as any)?.traderProfile), [(data as any)?.traderProfile]);
  const development = useMemo(
    () =>
      buildTraderDevelopment({
        trades: goalTrades,
        plans: (data as any)?.dailyPlans,
        traderProfile: (data as any)?.traderProfile,
      }),
    [goalTrades, (data as any)?.dailyPlans, (data as any)?.traderProfile]
  );
  const saveProfile = trpc.profile.save.useMutation();
  const goalEntries = useMemo(
    () =>
      (data?.goals ?? []).map((goal: any) =>
        assessTraderGoal(goal, goalTrades, data?.dailyPlans ?? [])
      ),
    [data?.goals, goalTrades, data?.dailyPlans]
  );
  const dangerGoals = goalEntries.filter(
    (entry: any) => entry.status === "AT_RISK" || entry.status === "BREACHED"
  );
  const goalAlertPayload = useMemo(
    () =>
      goalEntries
        .filter(
          (entry: any) =>
            entry.goal.active &&
            entry.goal.notify &&
            ["AT_RISK", "BREACHED"].includes(entry.status) &&
            entry.hasActivity
        )
        .map((entry: any) => ({
          goalId: entry.goal.id,
          status: entry.status,
          cycleKey: `${entry.goal.period}-${entry.periodLabel}`,
          message: `${entry.goal.name}: ${entry.status === "BREACHED" ? "threshold breached" : "near threshold"} (${entry.current} / ${entry.targetLabel}).`,
        })),
    [goalEntries]
  );
  useEffect(() => {
    // Publish the resolved account so the account manager, the exporters, the
    // risk calculator, and MT5 Live all read the same active account.
    if (account?.id) setSelectedAccountId(account.id);
  }, [account?.id]);
  useEffect(() => {
    if (!account?.id || !goalAlertPayload.length || recordGoalAlerts.isPending)
      return;
    void recordGoalAlerts
      .mutateAsync({ accountId: account.id, alerts: goalAlertPayload })
      .then(result => {
        if (result.recorded) void utils.notifications?.get?.invalidate?.();
      })
      .catch(() => undefined);
  }, [account?.id, goalAlertPayload, recordGoalAlerts, utils.notifications]);
  const switchAccount = React.useCallback(
    (nextAccountId: number) => {
      const target = Number(nextAccountId);
      if (!Number.isInteger(target) || target <= 0) return;
      // Dedupe the re-entrant selection event that publishing the selection
      // fires before React re-renders.
      if (target === accountId || target === switchTargetRef.current) return;
      switchTargetRef.current = target;
      // The account-switch transaction, in order:
      //   1. cancel the previous account's in-flight requests (beginAccountSwitch)
      //      so no late response can ever be committed for the new account;
      //   2. drop the previous account's cached payloads;
      //   3. publish + persist the selection;
      //   4. the new account's critical read mounts and runs first;
      //   5. secondary surfaces and MT5 polling start once it settles.
      // Nothing is invalidated here: invalidating would refetch the queries we
      // are leaving behind (the request storm), and the new account's queries
      // are not in the cache yet.
      setSwitchPending(true);
      setAccountId(target);
      setTradePage(1);
      setSelectedAccountId(target);
      void beginAccountSwitchForApp(target).then(result => {
        if (import.meta.env.DEV && (result.canceled || result.removed))
          console.info(
            `[account] switched to ${target} accountId; canceled=${result.canceled} removed=${result.removed}`
          );
      });
    },
    [accountId]
  );
  useEffect(
    () =>
      subscribeSelectedAccount(nextAccountId => {
        if (nextAccountId) switchAccount(nextAccountId);
      }),
    [switchAccount]
  );
  // Every account-scoped surface (exports, risk sizing, the MT5 view, the
  // account manager) reads the same shared selection, so switching here must
  // publish the choice instead of only holding it in local state.
  const selectAccount = React.useCallback(
    (nextAccountId: number) => {
      if (!nextAccountId) return;
      switchAccount(nextAccountId);
      setSelectedAccountId(nextAccountId);
    },
    [switchAccount]
  );
  useEffect(() => {
    setTradePage(1);
  }, [accountId, search, resultFilter]);
  // Account-scoped writes and manual refreshes still invalidate normally; only
  // the account SWITCH uses the cancel/drop transaction above.
  const refresh = () => refreshCurrentAccount(utils);
  // A switch ends as soon as the critical read for the new account settles, so
  // the secondary surfaces are enabled again by real data, not by a timer. The
  // failsafe only exists so a failed critical read cannot disable them forever.
  useEffect(() => {
    if (!switchPending) return;
    const critical =
      criticalView === "trades"
        ? tradeListQuery
        : criticalView === "mt5"
          ? mt5Workspace
          : journalQuery;
    const settled =
      !critical.isPlaceholderData && (critical.isSuccess || critical.isError);
    if (settled) setSwitchPending(false);
  }, [
    criticalView,
    journalQuery.isError,
    journalQuery.isPlaceholderData,
    journalQuery.isSuccess,
    mt5Workspace.isError,
    mt5Workspace.isPlaceholderData,
    mt5Workspace.isSuccess,
    switchPending,
    tradeListQuery.isError,
    tradeListQuery.isPlaceholderData,
    tradeListQuery.isSuccess,
  ]);
  useEffect(() => {
    if (!switchPending) return;
    const timer = window.setTimeout(() => setSwitchPending(false), 12_000);
    return () => window.clearTimeout(timer);
  }, [switchPending]);
  const accountSelectionPending =
    profileReady &&
    !accountListQuery.error &&
    !accountBootstrap.error &&
    (!accountSelectionResolved || !accountId);
  const journalLoading =
    profileLoading ||
    accountBootstrap.isLoading ||
    accountSelectionPending ||
    (Boolean(accountId) && journalQuery.isLoading && !journalQuery.isPlaceholderData);
  const journalError = accountBootstrap.error || journalQuery.error;
  // The visible view's first read. The Trade Log renders from its own paginated
  // trade list, so a slow or failed composite journal read can no longer replace
  // the whole Trade Log with a generic error: it degrades to a scoped notice.
  const tradeLogHasList = view === "trades" && Boolean(tradeListQuery.data);
  const blockingLoading = tradeLogHasList ? false : journalLoading;
  const blockingError = tradeLogHasList ? undefined : journalError;
  const compositeDegraded =
    view === "trades" && tradeLogHasList && Boolean(journalError);
  const switchingAccountName = ((ownedAccounts as any[]).find(
    item => Number(item.id) === accountId
  )?.name ?? "the selected account") as string;
  const retryJournal = React.useCallback(() => {
    void journalQuery.refetch();
    if (tradeListInput) void tradeListQuery.refetch();
  }, [journalQuery, tradeListInput, tradeListQuery]);
  const reconnectStatus = "ready";
  const reconnectSession = () => {
    void journalQuery.refetch();
  };
  useEffect(() => {
    window.addEventListener(JOURNAL_RETRY_EVENT, retryJournal);
    return () => window.removeEventListener(JOURNAL_RETRY_EVENT, retryJournal);
  }, [retryJournal]);
  const openNewTrade = (source?: any) => {
    const next = defaultTrade();
    if (source)
      Object.assign(next, {
        ...source,
        tradeDate: dateInput(),
        session: getPktSession(),
        risk: source.risk ?? "",
        reward: source.reward ?? "",
        pnl: source.pnl ?? "",
        patienceScore: source.patienceScore ? String(source.patienceScore) : "",
        mt5Ticket: source.mt5Ticket ?? "",
      });
    setEditing(undefined);
    setTradeForm(next);
    setScreenshot(undefined);
    setUploadProgress(0);
    setTradeDialog(true);
  };
  const openEdit = (trade: any) => {
    setEditing(trade);
    setTradeForm({
      tradeDate: dateInput(new Date(trade.tradeDate)),
      session: trade.session,
      direction: trade.direction,
      result: trade.result,
      level: trade.level || "",
      timeframe: trade.timeframe || "",
      setupQuality: trade.setupQuality || "",
      executionType: trade.executionType || "",
      marketCondition: trade.marketCondition || "",
      biasAlignment: trade.biasAlignment || "",
      confirmationType: trade.confirmationType || "",
      slPlacement: trade.slPlacement || "",
      tpPlacement: trade.tpPlacement || "",
      mistake: trade.mistake || "",
      holdQuality: trade.holdQuality || "",
      patienceScore: trade.patienceScore ? String(trade.patienceScore) : "",
      risk: trade.risk ?? "",
      reward: trade.reward ?? "",
      pnl: trade.pnl ?? "",
      notes: trade.notes || "",
      emotionBefore: trade.emotionBefore || "",
      emotionDuring: trade.emotionDuring || "",
      emotionAfter: trade.emotionAfter || "",
      planStatus: trade.planStatus === "PLANNED" || trade.planStatus === "UNPLANNED" ? trade.planStatus : "",
      planChecklist: Array.isArray(trade.planChecklist) ? (trade.planChecklist as { id?: string; checked?: boolean }[]).filter(item => item?.checked && item.id).map(item => String(item.id)).join("|") : "",
      mt5Ticket: trade.mt5Ticket ? String(trade.mt5Ticket) : "",
    });
    setScreenshot(undefined);
    setTradeDialog(true);
  };
  const submitTrade = async () => {
    if (!account) return;
    if (!tradeForm.direction || !tradeForm.result) {
      toast.error(
        "Select a direction and result before saving a manual trade."
      );
      return;
    }
    const date = Date.parse(`${tradeForm.tradeDate}T12:00:00+05:00`);
    if (
      !Number.isFinite(date) ||
      (!editing && isFuturePktDate(tradeForm.tradeDate))
    ) {
      toast.error("Future trade dates are not allowed.");
      return;
    }
    const payload = {
      accountId: account.id,
      tradeDate: date,
      session: tradeForm.session,
      direction: tradeForm.direction,
      result: tradeForm.result,
      level: tradeForm.level,
      timeframe: tradeForm.timeframe,
      setupQuality: tradeForm.setupQuality,
      executionType: tradeForm.executionType,
      marketCondition: tradeForm.marketCondition,
      biasAlignment: tradeForm.biasAlignment,
      confirmationType: tradeForm.confirmationType,
      slPlacement: tradeForm.slPlacement,
      tpPlacement: tradeForm.tpPlacement,
      mistake: tradeForm.mistake,
      holdQuality: tradeForm.holdQuality,
      patienceScore: tradeForm.patienceScore
        ? Number(tradeForm.patienceScore)
        : null,
      risk: tradeForm.risk === "" ? null : Number(tradeForm.risk),
      reward: tradeForm.reward === "" ? null : Number(tradeForm.reward),
      pnl: Number(tradeForm.pnl || 0),
      notes: tradeForm.notes,
      emotionBefore: tradeForm.emotionBefore,
      emotionDuring: tradeForm.emotionDuring,
      emotionAfter: tradeForm.emotionAfter,
      // "Not evaluated" is only recorded as such; a confirmed checklist is saved with its labels
      // so the engine and the calendar can re-read the same evidence later.
      planStatus: tradeForm.planStatus === "PLANNED" || tradeForm.planStatus === "UNPLANNED" ? tradeForm.planStatus : null,
      planChecklist: tradeForm.planChecklist
        ? PRE_TRADE_GATE_ITEMS.map(item => ({ id: item.id, label: item.label, checked: tradeForm.planChecklist.split("|").includes(item.id) }))
        : null,
      mt5Ticket: tradeForm.mt5Ticket || undefined,
    };
    // A new trade with a screenshot while online is saved directly so the image
    // attaches to a real record id in one step. Every other write is local-first:
    // it is stored and shown immediately, then synchronized with retry.
    const needsServerIdForScreenshot = Boolean(screenshot && !editing && isOnline);
    if (authUserId && !needsServerIdForScreenshot) {
      try {
        await localJournal.queueMutation({
          kind: editing ? "trade.update" : "trade.create",
          payload: editing
            ? { ...payload, tradeId: editing.id }
            : { ...payload, accountId: account.id },
        });
        if (screenshot)
          toast.warning(
            "Trade saved locally. Re-open it after sync to attach the screenshot."
          );
        else
          toast.success(
            isOnline
              ? "Trade saved locally and syncing now."
              : "Trade saved locally. It will sync automatically when you are online."
          );
        setTradeDialog(false);
        return;
      } catch {
        toast.error(
          "This browser could not store the trade locally. Please retry."
        );
        return;
      }
    }
    try {
      const result = editing
        ? await updateTrade.mutateAsync({ ...payload, tradeId: editing.id })
        : await createTrade.mutateAsync(payload);
      const tradeId = editing?.id ?? ("id" in result ? result.id : undefined);
      if (screenshot && tradeId) {
        const fileData = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(screenshot);
        });
        setUploadProgress(50);
        try {
          await uploadScreenshot.mutateAsync({
            tradeId,
            fileName: screenshot.name,
            mimeType: screenshot.type as
              | "image/jpeg"
              | "image/png"
              | "image/webp",
            base64: fileData,
          });
          setUploadProgress(100);
        } catch {
          toast.warning(
            "Trade saved but screenshot upload failed. Re-upload from edit."
          );
        }
      }
      toast.success(
        editing ? "Trade updated." : "Trade saved and balance recalculated."
      );
      setTradeDialog(false);
      refresh();
    } catch (error: any) {
      toast.error(error.message || "Trade could not be saved.");
    }
  };
  const exportRows = trades.map((trade: any, index: number) => ({
    "#": index + 1,
    Date: formatDate(trade.tradeDate),
    Session: trade.session,
    Side: trade.direction,
    Level: trade.level,
    Result: trade.result,
    Risk: toNumber(trade.risk),
    Reward: toNumber(trade.reward),
    "R:R": formatRr(trade.risk, trade.reward),
    "P&L": toNumber(trade.pnl),
    Notes: sanitize(trade.notes),
  }));
  const exportCsv = () => {
    const headers = Object.keys(exportRows[0] ?? { Date: "" });
    const rows = exportRows.map((row: Record<string, string | number>) =>
      headers
        .map(
          header =>
            `"${String(row[header as keyof typeof row] ?? "").replaceAll('"', '""')}"`
        )
        .join(",")
    );
    const blob = new Blob([[headers.join(","), ...rows].join("\n")], {
      type: "text/csv",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "GoldJournal_Trades.csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  const exportExcel = async () => {
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(exportRows),
        "Trades"
      );
      XLSX.writeFile(workbook, "GoldJournal_Trades.xlsx");
    } catch {
      toast.error("Excel export could not be completed.");
    }
  };
  const exportPdf = () =>
    window.dispatchEvent(new Event("gold-journal:bulk-pdf"));
  const requestInstall = async () => {
    if (installEvent) {
      installEvent.prompt();
      await installEvent.userChoice;
      setInstallEvent(undefined);
    } else setInstallHelp(true);
  };
  const pagedTrades = tradeListQuery.data?.trades ?? [];
  const authGate = getAuthGate(authStatus);
  // The splash and login screens already own a lazy gold Three.js hero
  // (GoldCanvas + its static CSS fallback), so they are not wrapped again here:
  // one WebGL context per surface, and the auth screens keep their own
  // premium gradient treatment.
  if (authGate === "splash") return <SplashScreen />;
  if (authGate === "auth-error")
    return (
      <AuthRecovery
        error={authError}
        onRetry={retryBootstrap}
        onReconnect={() => void reconnect()}
      />
    );
  if (authGate === "login") return <LoginScreen />;
  const TradeLog = TradeLogWithViewer;
  const MissedView = MissedTradesView;
  const CalendarView = PnlCalendarWithWeeks;
  const TradeDialog = TradeDialogWithCustomOptions;
  const PlanView = PlanExecutionEditor;
  const GoalsView = FlexibleGoalsView;
  const optionsPanel = (
    <>
      <OptionsView
        user={user}
        account={account}
        accounts={ownedAccounts.length ? ownedAccounts : (data?.accounts ?? [])}
        onAccount={selectAccount}
        onCreate={async (name: string) => {
          const result = await createAccount.mutateAsync({
            name,
            startingBalance: 0,
          });
          selectAccount(result.id);
          toast.success("New trading account created.");
          refresh();
        }}
        onClear={async () => {
          if (!account || !window.confirm("Clear all active-account trades?"))
            return;
          await clearAll.mutateAsync({
            accountId: account.id,
            confirmed: true,
          });
          refresh();
        }}
      />
      <UserAiProviderSettings />
    </>
  );
  return (
    <div className="gj-shell" data-view={view}>
      <AmbientField />
      <>
        {!isOnline && (
          <div className="offline-banner">
            <WifiOff size={15} /> You are offline — showing last synced data.
          </div>
        )}
        {authMeError && (
          <AuthProfileRecovery
            error={authMeError}
            onRetry={() => void authRefresh()}
            onReconnect={() => void reconnect()}
            onSignOut={logout}
          />
        )}
      </>
      <AppSidebar
        account={account}
        accounts={ownedAccounts.length ? ownedAccounts : (data?.accounts ?? [])}
        stats={stats}
        mt5Summary={activeMt5Connection}
        active={view}
        onView={(next: View) => {
          setView(next);
          setMobileNav(false);
        }}
        collapsed={collapsed}
        onCollapse={() => setCollapsed(!collapsed)}
        open={mobileNav}
        online={isOnline}
        alertCount={dangerGoals.length}
        user={user}
        onLogout={logout}
        onInstall={requestInstall}
        onAccount={selectAccount}
      />
      <main className="gj-main">
        <MobileTopbar
          onMenu={() => setMobileNav(true)}
          onAdd={() => openNewTrade()}
        />
        <PageHeader
          view={view}
          online={isOnline}
          alerts={dangerGoals.length}
          onNew={() => openNewTrade()}
          account={account}
          accounts={ownedAccounts.length ? ownedAccounts : (data?.accounts ?? [])}
          onAccount={selectAccount}
        />
        {data?.tradeSummaryError && (
          <div className="derived-status" role="status">
            <ShieldAlert size={15} />
            <span>{data.tradeSummaryError.message}</span>
            <Button variant="outline" size="sm" onClick={retryJournal}>
              Retry summary
            </Button>
          </div>
        )}
        {view === "options" ? (
          <div className="view-wrap">{optionsPanel}</div>
        ) : blockingLoading ? (
          switchPending ? (
            <SwitchingAccount name={switchingAccountName} />
          ) : (
            <Loading
              onReconnect={reconnectSession}
              reconnectStatus={reconnectStatus}
            />
          )
        ) : blockingError ? (
          <JournalQueryError
            error={blockingError}
            onRetry={retryJournal}
            title="We could not load this journal view."
          />
        ) : (
          <div className="view-wrap">
            {switchPending && (
              <div className="derived-status" role="status">
                <RefreshCcw size={15} />
                <span>
                  Switching to {switchingAccountName}… loading this account's data
                  first.
                </span>
              </div>
            )}
            {compositeDegraded && (
              <div className="derived-status" role="status">
                <ShieldAlert size={15} />
                <span>
                  {classifyApiError(journalError).title} — the trade list below is
                  still live.
                </span>
                <Button variant="outline" size="sm" onClick={retryJournal}>
                  Retry
                </Button>
              </div>
            )}
            {development.cooldown.status !== "CLEAR" && (view === "trades" || view === "goals" || view === "plan") && (
              <section className={`behavior-banner ${development.cooldown.status === "SESSION_COMPLETE" ? "complete" : ""}`} role="status">
                <ShieldAlert size={17} />
                <p>
                  <strong>{development.cooldown.status === "SESSION_COMPLETE" ? "SESSION COMPLETE" : "COOLDOWN"}</strong>
                  <span>{development.cooldown.message} {development.cooldown.actions[0] ?? ""}</span>
                </p>
                <button type="button" onClick={() => setView("psychology")}>Review development</button>
              </section>
            )}
            {view === "trades" && account && (
              <AccountStatusStrip
                accountName={account.name || "Active account"}
                mt5Connected={Boolean(activeMt5Connection)}
                online={isOnline}
                syncing={mt5Workspace.isFetching}
              />
            )}
            {view === "trades" && (
              <TradeLog
                stats={stats}
                trades={pagedTrades}
                allTrades={trades}
                pagination={tradeListQuery.data}
                listLoading={
                  tradeListQuery.isLoading || tradeListQuery.isFetching
                }
                listError={tradeListQuery.error}
                onRetry={() => void tradeListQuery.refetch()}
                account={account}
                dangerGoals={dangerGoals}
                mt5LivePositions={mt5Workspace.data?.openPositions ?? []}
                mt5Summary={activeMt5Connection}
                mt5Syncing={mt5Workspace.isFetching}
                hasMt5Connection={
                  (mt5Workspace.data?.connections?.length ?? 0) > 0
                }
                search={search}
                resultFilter={resultFilter}
                setSearch={setSearch}
                setResultFilter={setResultFilter}
                onPage={setTradePage}
                onNew={() => openNewTrade()}
                onDuplicate={() => openNewTrade(trades[0])}
                onEdit={openEdit}
                onDelete={async (id: number) => {
                  if (
                    !window.confirm(
                      "Delete this trade and remove its screenshot reference?"
                    )
                  )
                    return;
                  await deleteTrade.mutateAsync({ tradeId: id });
                  toast.success("Trade deleted.");
                  refresh();
                }}
                onCash={setCashDialog}
                onCsv={exportCsv}
                onExcel={exportExcel}
                onPdf={exportPdf}
                onClear={async () => {
                  if (
                    !account ||
                    !window.confirm(
                      "Permanently delete every trade in the active account?"
                    )
                  )
                    return;
                  await clearAll.mutateAsync({
                    accountId: account.id,
                    confirmed: true,
                  });
                  refresh();
                }}
              />
            )}
            {view === "missed" && (
              <MissedView
                rows={data?.skippedTrades ?? []}
                account={account}
                refresh={refresh}
              />
            )}
            {view === "analysis" && (
              <div className="view-hero-3d">
                <Premium3DBackground tone="blue" className="view-hero-3d-canvas" />
                <React.Suspense fallback={<Loading />}>
                  <AnalysisDashboardLazy accountId={account?.id} />
                </React.Suspense>
              </div>
            )}
            {view === "goals" && (
              <GoalsView
                account={account}
                goals={data?.goals ?? []}
                trades={goalTrades}
                plans={data?.dailyPlans ?? []}
                pending={
                  createGoal.isPending ||
                  updateGoal.isPending ||
                  deleteGoal.isPending ||
                  clearGoals.isPending
                }
                onCreate={async (draft: any) => {
                  if (!account) return;
                  await createGoal.mutateAsync({
                    accountId: account.id,
                    ...draft,
                  });
                  toast.success("Goal created.");
                  refresh();
                }}
                onUpdate={async (goal: any) => {
                  if (!account) return;
                  await updateGoal.mutateAsync({
                    ...goal,
                    accountId: account.id,
                    goalId: goal.id,
                  });
                  toast.success("Goal updated.");
                  refresh();
                }}
                onDelete={async (goal: any) => {
                  await deleteGoal.mutateAsync({ goalId: goal.id });
                  toast.success("Goal deleted.");
                  refresh();
                }}
                onClear={async () => {
                  if (!account) return;
                  await clearGoals.mutateAsync({
                    accountId: account.id,
                    confirmed: true,
                  });
                  refresh();
                }}
              />
            )}
            {view === "psychology" && (
              <section className="psychology-workspace">
                {/* The panel owns this destination: session psychology,
                    behavioural focus, cooldowns, streaks, and identity
                    consistency, separate from the Goals risk-control desk. */}
                <TraderDevelopmentPanel
                  report={development}
                  identityStatement={(data as any)?.traderProfile?.identityStatement ?? ""}
                  pending={saveProfile.isPending}
                  onSaveIdentity={async (statement: string) => {
                    try {
                      await saveProfile.mutateAsync({ identityStatement: statement });
                      toast.success("Trading identity saved.");
                      refresh();
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "The identity statement could not be saved.");
                    }
                  }}
                />
              </section>
            )}
            {view === "calendar" && (
              <CalendarView
                trades={trades}
                plans={data?.dailyPlans ?? []}
                behaviorConfig={behaviorConfig}
                onEdit={openEdit}
              />
            )}
            {view === "plan" && (
              <PlanView
                account={account}
                plans={data?.dailyPlans ?? []}
                onSaved={refresh}
              />
            )}
            {view === "mentor" && (
              <div className="view-hero-3d ai-surface-pad">
                <Premium3DBackground tone="violet" className="view-hero-3d-canvas" />
                <MentorView
                  trades={trades}
                  stats={stats}
                  account={account}
                  user={user}
                />
              </div>
            )}
            {view === "mt5" && (
              <Mt5LiveView
                account={account}
                accounts={
                  ownedAccounts.length ? ownedAccounts : (data?.accounts ?? [])
                }
                onJournalNow={(position: any) =>
                  openNewTrade({
                    direction: position.direction,
                    risk: String(position.riskUsd ?? ""),
                    reward: String(position.rewardUsd ?? ""),
                    pnl: String(position.realizedPnl ?? ""),
                    result: position.result,
                    mt5Ticket: position.ticket,
                    notes:
                      "MT5 trade auto-filled. Add your analysis details below.",
                  })
                }
                onSwitchAccount={selectAccount}
              />
            )}
          </div>
        )}
      </main>
      <MobileNav active={view} onView={setView} />
      <AccountRenameControl />
      <OptionListManager />
      <BulkPdfExporter />
      <TradeDialog
        open={tradeDialog}
        setOpen={setTradeDialog}
        form={tradeForm}
        setForm={setTradeForm}
        editing={editing}
        onSave={submitTrade}
        pending={createTrade.isPending || updateTrade.isPending}
        screenshot={screenshot}
        setScreenshot={setScreenshot}
        progress={uploadProgress}
        plans={data?.dailyPlans ?? []}
        dayTrades={(trades as any[]).filter((trade: any) => dateInput(new Date(trade.tradeDate)) === tradeForm.tradeDate)}
        behaviorConfig={behaviorConfig}
      />
      <CashDialog
        type={cashDialog}
        setType={setCashDialog}
        amount={cashAmount}
        setAmount={setCashAmount}
        note={cashNote}
        setNote={setCashNote}
        onSave={async () => {
          if (!account || !cashDialog || Number(cashAmount) <= 0) return;
          await createCash.mutateAsync({
            accountId: account.id,
            movementDate: Date.now(),
            type: cashDialog,
            amount: Number(cashAmount),
            note: cashNote,
          });
          toast.success("Cash movement saved.");
          setCashDialog(null);
          setCashAmount("");
          setCashNote("");
          refresh();
        }}
        pending={createCash.isPending}
      />
      <InstallDialog open={installHelp} setOpen={setInstallHelp} />
    </div>
  );
}

function AppSidebar({
  account,
  accounts,
  stats,
  mt5Summary,
  active,
  onView,
  collapsed,
  onCollapse,
  open,
  online,
  alertCount,
  user,
  onLogout,
  onInstall,
  onAccount,
}: any) {
  const broker = mt5Summary;
  const hasBrokerBalance = broker?.balance != null;
  /**
   * Drawer geometry is asserted inline.
   *
   * Below 1024px the sidebar IS the navigation, so its open state must never be
   * decided by a specificity contest: `index.css` (≤1120px and ≤760px) and
   * `premium-terminal.css` both declare `.gj-sidebar` widths, and the collapsed
   * rail preference is remembered in `localStorage` across reloads. A drawer
   * that resolves to the 76px rail, or stays at `translateX(-104%)` behind a
   * scrim while the body is scroll-locked, looks like a frozen app. Inline wins
   * deterministically over all of them, and `z-index` above every in-app layer
   * (floating action stack 148-151, bottom nav 40, topbar 30) keeps the menu on
   * top wherever it is opened from. Above 1024px the rail stays pure CSS so the
   * collapse animation is unaffected.
   */
  const drawerMode = useIsDrawerNav();
  const drawerStyle: React.CSSProperties | undefined = drawerMode
    ? {
        width: "min(20rem, 86vw)",
        transform: open ? "translateX(0)" : "translateX(-104%)",
        visibility: open ? "visible" : "hidden",
        pointerEvents: open ? "auto" : "none",
        zIndex: 300,
      }
    : undefined;
  return (
    <>
      <aside
        className={`gj-sidebar ${open ? "is-open" : ""} ${collapsed ? "is-collapsed" : ""}`}
        data-nav={open ? "open" : "closed"}
        style={drawerStyle}
      >
        <div className="sidebar-brand">
          <GoldMark />
          <div className="brand-copy">
            <strong>Gold Journal</strong>
            <span>TRADE WITH INTENT</span>
          </div>
          <button className="collapse-button desktop-only" onClick={onCollapse}>
            {collapsed ? (
              <PanelLeftOpen size={17} />
            ) : (
              <PanelLeftClose size={17} />
            )}
          </button>
          {/* Drawer-only exit: the rail toggle is meaningless off-canvas, and a
              visible close control beats hoping the user taps the scrim. */}
          <button
            className="drawer-close"
            aria-label="Close navigation"
            onClick={() => onView(active)}
          >
            <X size={17} />
          </button>
        </div>
        <div className="account-switcher">
          <p>ACTIVE ACCOUNT</p>
          <select
            value={account?.id || ""}
            onChange={event => onAccount(Number(event.target.value))}
          >
            {accounts.map((item: any) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <ChevronDown size={15} />
        </div>
        <nav className="sidebar-nav">
          {navItems.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={active === item.id ? "active" : ""}
                onClick={() => onView(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {item.id === "goals" && alertCount > 0 && <em>{alertCount}</em>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sync-row">
            {online ? <Wifi size={15} /> : <WifiOff size={15} />}
            <span>{online ? "Synced" : "Offline"}</span>
            <i />
          </div>
          <div className="side-balance">
            <span>{hasBrokerBalance ? "MT5 balance" : "Account balance"}</span>
            <strong className="data-text">
              {formatMoney(hasBrokerBalance ? broker.balance : stats.balance)}
            </strong>
            <small>
              {hasBrokerBalance
                ? `Equity ${formatMoney(broker.equity)}`
                : `${stats.winRate.toFixed(1)}% win rate`}
            </small>
          </div>
          <Button className="install-button" onClick={onInstall}>
            <Download size={15} />
            <span>Install App</span>
          </Button>
          <button className="user-row" onClick={onLogout}>
            <span className="avatar">{initials(user?.name)}</span>
            <span className="user-copy">
              <strong>{user?.name || "Gold Trader"}</strong>
              <small>Sign out</small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      {open && (
        <button
          className="drawer-scrim"
          aria-label="Close menu"
          onClick={() => onView(active)}
        />
      )}
    </>
  );
}
function MobileTopbar({ onMenu, onAdd }: any) {
  return (
    <header className="mobile-topbar">
      <button onClick={onMenu}>
        <Menu size={21} />
      </button>
      <div>
        <GoldMark size={27} />
        <strong>Gold Journal</strong>
      </div>
      <div className="mobile-top-actions">
        <ThemeToggle />
        <button className="quick-add" onClick={onAdd}>
          <Plus size={19} />
        </button>
      </div>
    </header>
  );
}
function JournalSyncIndicator() {
  const { session } = useAuth();
  const [state, setState] = useState<JournalSyncState>("synced");
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      const subject = session?.user?.id ?? null;
      const pending = subject ? await queuedJournalMutationCount(subject) : 0;
      if (cancelled) return;
      setCount(pending);
      setState(
        pending === 0 ? "synced" : isOnline() ? "pending" : "offline"
      );
    };
    const onChange = () => void update();
    void update();
    const unsubscribeAccount = subscribeSelectedAccount(onChange);
    window.addEventListener(JOURNAL_LOCAL_EVENT, onChange);
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    return () => {
      cancelled = true;
      unsubscribeAccount();
      window.removeEventListener(JOURNAL_LOCAL_EVENT, onChange);
      window.removeEventListener("online", onChange);
      window.removeEventListener("offline", onChange);
    };
  }, [session?.user?.id]);
  if (count === 0 && state === "synced") return null;
  const label =
    state === "offline"
      ? "Saved locally — offline"
      : state === "failed"
        ? `${count} sync failed — retrying`
        : state === "syncing"
          ? `${count} syncing`
          : `${count} waiting to sync`;
  return (
    <span
      className={`sync-chip queue-sync-chip ${state}`}
      title="Local journal saves sync automatically for this signed-in account."
    >
      <RefreshCcw size={14} /> {label}
    </span>
  );
}
function AccountSwitcher({ account, accounts, onAccount }: any) {
  if (!accounts?.length) return null;
  return (
    <label className="pagebar-account">
      <Wallet size={14} />
      <span className="sr-only">Active trading account</span>
      <select
        aria-label="Active trading account"
        value={account?.id || ""}
        onChange={event => onAccount(Number(event.target.value))}
      >
        {accounts.map((item: any) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <ChevronDown size={14} />
    </label>
  );
}
function PageHeader({ view, online, onNew, account, accounts, onAccount }: any) {
  const title =
    navItems.find(item => item.id === view)?.label || "Gold Journal";
  return (
    <>
      {view === "risk" && <RiskCalculatorPanel />}
      <header className="desktop-pagebar">
        <div>
          <p>{view === "trades" ? "TRADING PERFORMANCE" : "GOLD JOURNAL"}</p>
          <h1>{title}</h1>
        </div>
        <div className="pagebar-actions">
          <AccountSwitcher account={account} accounts={accounts} onAccount={onAccount} />
          <span className="sync-chip">
            <Cloud size={14} /> {online ? "Live cloud sync" : "Offline"}
          </span>
          <JournalSyncIndicator />
          <ThemeToggle />
          <NotificationCenter triggerClassName="icon-button" />
          <Button onClick={onNew}>
            <Plus size={16} /> New Trade
          </Button>
        </div>
      </header>
    </>
  );
}
function MobileNav({
  active,
  onView,
}: {
  active: View;
  onView: (view: View) => void;
}) {
  const items = mobileNavIds
    .map(id => navItems.find(item => item.id === id))
    .filter((item): item is (typeof navItems)[number] => Boolean(item));
  return (
    <nav className="mobile-bottom-nav">
      {items.map(item => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            className={active === item.id ? "active" : ""}
            onClick={() => onView(item.id)}
          >
            <Icon size={18} />
            <span>{item.label.replace(" Trades", "")}</span>
          </button>
        );
      })}
    </nav>
  );
}
export function Loading({
  onReconnect = () =>
    window.dispatchEvent(new Event("gold-journal:auth-request")),
  reconnectStatus = "ready",
}: {
  onReconnect?: () => void;
  reconnectStatus?: "ready" | "checking" | "unavailable";
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 8_000);
    return () => window.clearTimeout(timer);
  }, []);
  return slow ? (
    <SessionRecovery
      onRetry={() => window.dispatchEvent(new Event(JOURNAL_RETRY_EVENT))}
      onReconnect={onReconnect}
      reconnectStatus={reconnectStatus}
    />
  ) : (
    <div className="page-loader">
      <div />
      <span>Loading your secure journal…</span>
    </div>
  );
}
export function QueryError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const message =
    error instanceof Error
      ? error.message
      : "Your journal could not be loaded.";
  return (
    <section className="panel query-error">
      <ShieldAlert size={25} />
      <div>
        <span className="eyebrow">SYNC NEEDS ATTENTION</span>
        <h2>We could not load this journal view.</h2>
        <p>{message}</p>
        <Button onClick={onRetry}>
          <RefreshCcw size={15} /> Try again
        </Button>
      </div>
    </section>
  );
}

function MissedView({ rows, account, refresh }: any) {
  const createSkipped = trpc.skipped.create.useMutation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    date: dateInput(),
    session: getPktSession(),
    direction: "BUY",
    reason: "Fear - SL looked too big",
    confidence: "3",
    outcome: "TP Hit - Full",
    missed: "",
    notes: "",
  });
  return (
    <>
      <section className="section-heading">
        <div>
          <span className="eyebrow">OPPORTUNITY REVIEW</span>
          <h2>Missed / skipped trades</h2>
          <p>
            Track what you saw, why you passed, and what happened afterwards.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus size={16} /> Log Skipped Trade
        </Button>
      </section>
      <div className="stats-grid compact">
        <StatCard
          label="Total skipped"
          value={String(rows.length)}
          detail="Recorded opportunities"
          tone="neutral"
        />
        <StatCard
          label="Estimated missed"
          value={formatMoney(
            rows.reduce(
              (sum: number, row: any) => sum + toNumber(row.estimatedMissed),
              0
            )
          )}
          detail="Potential, not realized"
        />
        <StatCard
          label="Top reason"
          value={rows[0]?.skipReason || "—"}
          detail="Based on entries"
          tone="neutral"
        />
      </div>
      <section className="panel">
        {rows.length ? (
          <div className="trade-table-wrap">
            <table className="trade-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Session</th>
                  <th>Direction</th>
                  <th>Reason</th>
                  <th>Confidence</th>
                  <th>Outcome</th>
                  <th>Est. missed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row: any) => (
                  <tr key={row.id}>
                    <td className="data-text">{formatDate(row.tradeDate)}</td>
                    <td>{row.session}</td>
                    <td>{row.direction}</td>
                    <td>{row.skipReason}</td>
                    <td>{row.confidence}/5</td>
                    <td>{row.outcome}</td>
                    <td className="positive data-text">
                      {formatMoney(row.estimatedMissed)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No skipped opportunities yet."
            copy="Logging a skipped setup turns a moment of uncertainty into reviewable evidence."
          />
        )}
      </section>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log skipped trade</DialogTitle>
            <DialogDescription>
              Capture the missed opportunity without diluting the main trade
              log.
            </DialogDescription>
          </DialogHeader>
          <div className="stacked-fields">
            <Field label="Date">
              <Input
                type="date"
                value={form.date}
                onChange={event =>
                  setForm({ ...form, date: event.target.value })
                }
              />
            </Field>
            <Field label="Session">
              <select
                value={form.session}
                onChange={event =>
                  setForm({ ...form, session: event.target.value })
                }
              >
                {sessions.map(item => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
            <Field label="Skip reason">
              <Input
                value={form.reason}
                onChange={event =>
                  setForm({ ...form, reason: event.target.value })
                }
              />
            </Field>
            <Field label="Outcome">
              <Input
                value={form.outcome}
                onChange={event =>
                  setForm({ ...form, outcome: event.target.value })
                }
              />
            </Field>
            <Field label="Estimated $ missed">
              <Input
                type="number"
                value={form.missed}
                onChange={event =>
                  setForm({ ...form, missed: event.target.value })
                }
              />
            </Field>
            <Field label="Notes">
              <Textarea
                value={form.notes}
                onChange={event =>
                  setForm({ ...form, notes: event.target.value })
                }
              />
            </Field>
          </div>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!account) return;
                await createSkipped.mutateAsync({
                  accountId: account.id,
                  tradeDate: new Date(`${form.date}T12:00:00`).getTime(),
                  session: form.session,
                  level: "",
                  timeframe: "",
                  direction: form.direction as "BUY" | "SELL",
                  skipReason: form.reason,
                  confidence: Number(form.confidence),
                  outcome: form.outcome,
                  estimatedMissed: Number(form.missed || 0),
                  notes: form.notes,
                });
                toast.success("Skipped trade logged.");
                setOpen(false);
                refresh();
              }}
            >
              Save skipped trade
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MentorView({ account }: any) {
  const aiSettings = useAiSettings();
  const behaviorEvidence = trpc.analysis.get.useQuery(
    { accountId: account?.id ?? 0, filters: {} },
    { enabled: Boolean(account?.id), staleTime: 30_000, refetchOnWindowFocus: false }
  );
  const saveAiReport = trpc.analysis.saveAiReport.useMutation();
  const [ai, setAi] = useState<AiAnalysisOutcome | null>(null);
  const [mentorUiState, setMentorUiState] = useState<AiUiState>("ready");
  const mentorAbortRef = useRef<AbortController | null>(null);
  const pending = mentorUiState === "analyzing";
  const run = async () => {
    if (!account?.id || !behaviorEvidence.data || pending) return;
    mentorAbortRef.current?.abort();
    const controller = new AbortController();
    mentorAbortRef.current = controller;
    setAi(null);
    setMentorUiState("analyzing");
    const outcome = await analyzeJournal({
      analysis: behaviorEvidence.data as unknown as AnalysisResult,
      signal: controller.signal,
      model: aiSettings.model ?? undefined,
    });
    if (controller.signal.aborted) {
      setMentorUiState("cancelled");
      return;
    }
    setAi(outcome);
    if (outcome.available && outcome.report) {
      setMentorUiState("success");
      try {
        await saveAiReport.mutateAsync({
          accountId: account.id,
          filters: {},
          model: outcome.model ?? "unknown",
          report: outcome.report,
        });
      } catch {
        // Historical persistence is best-effort; the report stays visible.
      }
    } else {
      setMentorUiState(uiStateForErrorCode(outcome.errorCode));
    }
  };
  const report = ai?.report;
  const behavior: any = (behaviorEvidence.data as any)?.behavior;
  return (
    <>
      <section className="section-heading">
        <div>
          <span className="eyebrow">BEHAVIORAL INTELLIGENCE</span>
          <h2>AI Edge Analyst</h2>
          <p>
            Interpretation runs from compact deterministic aggregates. No key,
            JWT, screenshot, or raw journal note is sent from this browser.
          </p>
        </div>
      </section>
      <section className="panel mentor-run">
        <div className="mentor-icon">
          <Bot size={30} />
        </div>
        <h3>Evidence-bound trading report</h3>
        <p>
          AI is optional and never gates deterministic Analysis. It cannot issue
          BUY/SELL signals or invent journal statistics.
        </p>
        {!aiSettings.configured && (
          <div className="analysis-ai-empty">
            <Bot size={20} />
            <div>
              <strong>Google AI is not configured in this browser.</strong>
              <p>
                Add your own Google AI Studio key in Options. The key stays in
                this browser and requests go directly to Google AI.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => openJournalView("options")}
              >
                Open Options
              </Button>
            </div>
          </div>
        )}
        {behavior && (
          <section className="analysis-ai-report" aria-label="Deterministic behavior baseline">
            <span className="section-label">DETERMINISTIC BEHAVIOR BASELINE</span>
            <p>
              This is saved journal evidence, not a diagnosis. High activity is a
              concentration signal only; FOMO, revenge, overtrading, or oversizing
              appear here only when you tagged the related trade.
            </p>
            <div className="risk-result-grid">
              <RiskMetric label="Behavior-tagged" value={`${behavior.coverage.taggedTrades}/${behavior.coverage.closedTrades}`} detail="Closed trades with saved process tags" />
              <RiskMetric label="Emotion captured" value={`${behavior.coverage.emotionTaggedTrades}/${behavior.coverage.closedTrades}`} detail="Closed trades with an emotion field" />
              <RiskMetric label="Avg trades / day" value={String(behavior.activity.averageTradesPerActiveDay)} detail={`${behavior.activity.activeDays} active PKT days`} />
              <RiskMetric label="Most active day" value={String(behavior.activity.maxTradesInDay)} detail={`${behavior.activity.concentratedDays} concentrated day(s), not proof of overtrading`} />
            </div>
            <div className="analysis-ai-columns">
              <section>
                <span className="section-label">SAVED PROCESS TAGS</span>
                {behavior.tags.length ? behavior.tags.slice(0, 6).map((item: any) => (
                  <article className="ai-evidence-card" key={item.label}>
                    <strong>{item.label}</strong>
                    <p>{item.sample} tagged trade(s) · {item.expectancy >= 0 ? "+" : ""}{formatMoney(item.expectancy)} average P&amp;L</p>
                    <small>{item.confidence} confidence · tag only, not a psychological conclusion</small>
                  </article>
                )) : <p>No behavior tags are saved yet. Tag FOMO, revenge, overtrading, oversizing, or custom behaviors on a trade to review them here.</p>}
              </section>
              <section>
                <span className="section-label">EMOTIONAL CONTEXT</span>
                {behavior.emotions.length ? behavior.emotions.slice(0, 6).map((item: any) => (
                  <article className="ai-evidence-card" key={item.label}>
                    <strong>{item.label}</strong>
                    <p>{item.sample} tagged trade(s) · {item.expectancy >= 0 ? "+" : ""}{formatMoney(item.expectancy)} average P&amp;L</p>
                    <small>{item.confidence} confidence · self-reported journal context</small>
                  </article>
                )) : <p>No emotion fields are saved yet. Add how you felt before, during, and after a trade for useful behavioral review.</p>}
              </section>
            </div>
            {behavior.limitations.length > 0 && (
              <div className="analysis-ai-empty">
                <ShieldAlert size={18} />
                <div><strong>Behavior evidence is incomplete.</strong>{behavior.limitations.map((item: string) => <p key={item}>{item}</p>)}</div>
              </div>
            )}
          </section>
        )}
        <div className="ai-action-row">
          <Button
            size="lg"
            disabled={pending || !account?.id || !aiSettings.configured}
            onClick={() => void run()}
          >
            {pending ? "Analyzing in your browser…" : "Analyze my journal"}
          </Button>
          {pending && (
            <Button
              variant="outline"
              size="lg"
              onClick={() => mentorAbortRef.current?.abort()}
            >
              Cancel
            </Button>
          )}
        </div>
        {pending && (
          <div className="analysis-ai-empty">
            <Bot size={20} />
            <p>
              This browser is calling Google AI directly. Nothing is sent to
              Gold Journal servers, and you can cancel at any time.
            </p>
          </div>
        )}
        {!pending && ai && !ai.available && (
          <div className="analysis-ai-empty">
            <ShieldAlert size={20} />
            <div>
              <strong>{AI_UI_COPY[mentorUiState].title}</strong>
              <p>{ai.message ?? "Add your key in Options and retry."}</p>
              {aiSettings.configured && mentorUiState !== "not_configured" && (
                <Button variant="outline" size="sm" onClick={() => void run()}>
                  Retry
                </Button>
              )}
            </div>
          </div>
        )}
        {report && (
          <div className="analysis-ai-report">
            <div className="analysis-ai-summary">
              <span className="section-label">DIRECT, EVIDENCE-BOUND VERDICT</span>
              <p>{report.executiveSummary}</p>
            </div>
            <div className="analysis-ai-columns">
              <section>
                <span className="section-label">STRONGEST EDGES</span>
                {report.strongestEdges.map((item: any) => (
                  <article className="ai-evidence-card" key={item.label}>
                    <strong>{item.label}</strong>
                    <p>{item.claim}</p>
                    <small>
                      {item.sample} trades · {item.confidence} confidence ·{" "}
                      {item.evidence}
                    </small>
                  </article>
                ))}
              </section>
              <section>
                <span className="section-label">NEXT HYPOTHESES</span>
                {report.edgeHypotheses.map((item: any) => (
                  <article className="ai-evidence-card" key={item.title}>
                    <strong>{item.title}</strong>
                    <p>{item.statement}</p>
                    <small>
                      {item.confidence} confidence · Next test: {item.nextTest}
                    </small>
                  </article>
                ))}
              </section>
            </div>
            <div className="analysis-ai-columns">
              <section>
                <span className="section-label">WEAKEST CONTEXTS</span>
                {report.weakestContexts.length ? report.weakestContexts.map((item: any) => (
                  <article className="ai-evidence-card" key={`${item.label}-${item.claim}`}>
                    <strong>{item.label}</strong>
                    <p>{item.claim}</p>
                    <small>{item.sample} trades · {item.confidence} confidence · {item.evidence}</small>
                  </article>
                )) : <p>No qualified weak context can be supported by this sample.</p>}
              </section>
              <section>
                <span className="section-label">LEAKS AND BLIND SPOTS</span>
                {(report.behavioralLeaks.length ? report.behavioralLeaks : report.winLossDifferences.potentialLeaks).map((item: string) => <p key={item}>• {item}</p>)}
                {!report.behavioralLeaks.length && !report.winLossDifferences.potentialLeaks.length && <p>No behavioral conclusion can be supported from the saved fields.</p>}
                {[...report.dataQuality.missing, ...report.dataQuality.warnings].map((item: string) => <p key={item}>• {item}</p>)}
              </section>
            </div>
            <details className="analysis-details">
              <summary>Controlled experiments before changing your strategy</summary>
              {report.experiments.map((item: any) => <p key={item.name}><b>{item.name}:</b> {item.compare} Required sample: {item.requiredSample}. {item.caution}</p>)}
            </details>
          </div>
        )}
      </section>
    </>
  );
}

export function OptionsView({
  user,
  account,
  accounts,
  onAccount,
  onCreate,
  onClear,
}: any) {
  const [name, setName] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <>
      <section className="section-heading">
        <div>
          <span className="eyebrow">CONTROL CENTER</span>
          <h2>Options</h2>
          <p>
            Manage accounts, reusable journal lists, and security-sensitive
            actions.
          </p>
        </div>
      </section>
      <div className="options-grid">
        <section className="panel profile-panel">
          <span className="section-label">PROFILE</span>
          <div className="profile-row">
            <span className="avatar large">{initials(user?.name)}</span>
            <div>
              <strong>{user?.name || "Gold Trader"}</strong>
              <p>{user?.email || "Authenticated account"}</p>
            </div>
          </div>
          <div className="profile-meta">
            <span>
              Provider <b>Secure cloud sign-in</b>
            </span>
            <span>
              Data scope <b>Private to this account</b>
            </span>
          </div>
        </section>
        <section className="panel account-panel">
          <span className="section-label">TRADING ACCOUNTS</span>
          <div className="account-list">
            {accounts.map((item: any) => (
              <button
                key={item.id}
                className={item.id === account?.id ? "current" : ""}
                onClick={() => onAccount(item.id)}
              >
                <span>
                  <Wallet size={15} /> {item.name}
                </span>
                {item.id === account?.id && <Check size={15} />}
              </button>
            ))}
          </div>
          <div className="inline-form">
            <Input
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="New account name"
            />
            <Button
              disabled={!name.trim()}
              onClick={() => {
                onCreate(name.trim());
                setName("");
              }}
            >
              <Plus size={15} /> Add
            </Button>
          </div>
        </section>
        <section className="panel list-manager">
          <TradeOptionManager />
        </section>
        <section className="panel danger-zone">
          <span className="section-label">DANGER ZONE</span>
          <h3>Clear active account trades</h3>
          <p>
            This permanently removes the current account's trade log. Cash
            movements are retained separately.
          </p>
          <Button
            variant="outline"
            className="danger-button"
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 size={15} /> Clear all trades
          </Button>
        </section>
      </div>
      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear active account trades?</DialogTitle>
            <DialogDescription>
              This permanently removes every trade in{" "}
              {account?.name || "the active account"}. Cash movements remain.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button
              className="danger-button"
              onClick={() => {
                onClear();
                setConfirmClear(false);
              }}
            >
              Confirm clear
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TradeDialog({
  open,
  setOpen,
  form,
  setForm,
  editing,
  onSave,
  pending,
  screenshot,
  setScreenshot,
  progress,
}: any) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="trade-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit trade" : "New trade"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the journal detail and retain the original session."
              : "Session is detected from Pakistan Standard Time and can be overridden."}
          </DialogDescription>
        </DialogHeader>
        <div className="trade-form">
          <FormSection title="Trade details">
            <Field label="Date">
              <Input
                type="date"
                value={form.tradeDate}
                max={dateInput()}
                onChange={event =>
                  setForm({ ...form, tradeDate: event.target.value })
                }
              />
            </Field>
            <Field label="Session">
              <select
                value={form.session}
                onChange={event =>
                  setForm({ ...form, session: event.target.value })
                }
              >
                {sessions.map(item => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
            <Field label="Direction">
              <select
                value={form.direction}
                onChange={event =>
                  setForm({ ...form, direction: event.target.value })
                }
              >
                <option>BUY</option>
                <option>SELL</option>
              </select>
            </Field>
            <Field label="Result">
              <select
                value={form.result}
                onChange={event =>
                  setForm({ ...form, result: event.target.value })
                }
              >
                {results.map(item => (
                  <option key={item} value={item}>
                    {item.replace("_", " ")}
                  </option>
                ))}
              </select>
            </Field>
          </FormSection>
          <FormSection title="Strategy">
            <Field label="Level">
              <select
                value={form.level}
                onChange={event =>
                  setForm({ ...form, level: event.target.value })
                }
              >
                <option value="">Select level</option>
                {levels.map(item => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
            <Field label="Timeframe">
              <select
                value={form.timeframe}
                onChange={event =>
                  setForm({ ...form, timeframe: event.target.value })
                }
              >
                {["1m", "5m", "15m", "H1", "4H"].map(item => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
            <Field label="Setup quality">
              <select
                value={form.setupQuality}
                onChange={event =>
                  setForm({ ...form, setupQuality: event.target.value })
                }
              >
                {["A+", "A", "B"].map(item => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
            <Field label="Confirmation">
              <Input
                value={form.confirmationType}
                placeholder="BOS, CHoCH…"
                onChange={event =>
                  setForm({ ...form, confirmationType: event.target.value })
                }
              />
            </Field>
          </FormSection>
          <FormSection title="Execution">
            <Field label="Execution type">
              <select
                value={form.executionType}
                onChange={event =>
                  setForm({ ...form, executionType: event.target.value })
                }
              >
                {executionTypes.map(item => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
            <Field label="Market condition">
              <Input
                value={form.marketCondition}
                placeholder="Bullish, ranging…"
                onChange={event =>
                  setForm({ ...form, marketCondition: event.target.value })
                }
              />
            </Field>
            <Field label="Patience 1–5">
              <Input
                type="number"
                min="1"
                max="5"
                value={form.patienceScore}
                onChange={event =>
                  setForm({ ...form, patienceScore: event.target.value })
                }
              />
            </Field>
          </FormSection>
          <FormSection title="Risk">
            <Field label="Risk $">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.risk}
                onChange={event =>
                  setForm({ ...form, risk: event.target.value })
                }
              />
            </Field>
            <Field label="Reward $">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.reward}
                onChange={event =>
                  setForm({ ...form, reward: event.target.value })
                }
              />
            </Field>
            <Field label="P&L $">
              <Input
                type="number"
                step="0.01"
                value={form.pnl}
                onChange={event =>
                  setForm({ ...form, pnl: event.target.value })
                }
              />
            </Field>
            <div className="rr-live">
              <span>LIVE R:R</span>
              <strong className="data-text">
                {formatRr(form.risk, form.reward)}
              </strong>
            </div>
          </FormSection>
          <FormSection title="Screenshot">
            <div
              className="upload-box"
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus size={20} />
              <div>
                <strong>
                  {screenshot
                    ? screenshot.name
                    : "Click to upload a screenshot"}
                </strong>
                <span>JPG, PNG or WEBP · 5MB maximum</span>
              </div>
              <input
                ref={fileRef}
                hidden
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (
                    !["image/jpeg", "image/png", "image/webp"].includes(
                      file.type
                    )
                  ) {
                    toast.error("Use a JPG, PNG, or WEBP screenshot.");
                    return;
                  }
                  if (file.size > 5 * 1024 * 1024) {
                    toast.error("Screenshot must be 5MB or smaller.");
                    return;
                  }
                  setScreenshot(file);
                }}
              />
            </div>
            {progress > 0 && (
              <div className="upload-progress">
                <i style={{ width: `${progress}%` }} />
              </div>
            )}
          </FormSection>
          <FormSection title="Emotions">
            <Field label="Before trade">
              <Textarea
                value={form.emotionBefore}
                placeholder="Calm, focused, dar raha tha…"
                onChange={event =>
                  setForm({ ...form, emotionBefore: event.target.value })
                }
              />
            </Field>
            <Field label="During trade">
              <Textarea
                value={form.emotionDuring}
                placeholder="What were you thinking?"
                onChange={event =>
                  setForm({ ...form, emotionDuring: event.target.value })
                }
              />
            </Field>
            <Field label="After trade">
              <Textarea
                value={form.emotionAfter}
                placeholder="Satisfied, gussa aya, should have held…"
                onChange={event =>
                  setForm({ ...form, emotionAfter: event.target.value })
                }
              />
            </Field>
          </FormSection>
          <FormSection title="Notes">
            <Textarea
              value={form.notes}
              rows={4}
              placeholder="English + Roman Urdu supported…"
              onChange={event =>
                setForm({ ...form, notes: event.target.value })
              }
            />
          </FormSection>
        </div>
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={onSave}>
            {pending ? "Saving…" : editing ? "Save changes" : "Save trade"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
function CashDialog({
  type,
  setType,
  amount,
  setAmount,
  note,
  setNote,
  onSave,
  pending,
}: any) {
  const save = () => {
    if (!navigator.onLine) {
      window.dispatchEvent(
        new CustomEvent(OFFLINE_CASH_REQUEST_EVENT, {
          detail: { type, amount: Number(amount), note },
        })
      );
      return;
    }
    onSave();
  };
  return (
    <Dialog open={Boolean(type)} onOpenChange={open => !open && setType(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {type === "DEPOSIT" ? "Deposit funds" : "Withdraw funds"}
          </DialogTitle>
          <DialogDescription>
            The cash movement recalculates balance immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="stacked-fields">
          <Field label="Amount">
            <Input
              autoFocus
              type="number"
              min="0.01"
              value={amount}
              onChange={event => setAmount(event.target.value)}
            />
          </Field>
          <Field label="Note">
            <Textarea
              value={note}
              onChange={event => setNote(event.target.value)}
            />
          </Field>
        </div>
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => setType(null)}>
            Cancel
          </Button>
          <Button disabled={pending || Number(amount) <= 0} onClick={save}>
            {pending ? "Saving…" : "Save movement"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
function GoalDialog({ open, setOpen, draft, setDraft, onSave }: any) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add custom goal</DialogTitle>
          <DialogDescription>
            Create a trackable goal for the active account.
          </DialogDescription>
        </DialogHeader>
        <div className="stacked-fields">
          <Field label="Name">
            <Input
              value={draft.name}
              onChange={event =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </Field>
          <Field label="Description">
            <Input
              value={draft.description}
              onChange={event =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </Field>
          <Field label="Period">
            <select
              value={draft.period}
              onChange={event =>
                setDraft({ ...draft, period: event.target.value })
              }
            >
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
            </select>
          </Field>
          <Field label="Metric">
            <select
              value={draft.metric}
              onChange={event =>
                setDraft({ ...draft, metric: event.target.value })
              }
            >
              <option value="trade_count">Trade count</option>
              <option value="net_pnl">Net P&L</option>
              <option value="win_rate">Win rate</option>
              <option value="avg_rr">Average R:R</option>
            </select>
          </Field>
          <Field label="Direction">
            <select
              value={draft.comparison}
              onChange={event =>
                setDraft({ ...draft, comparison: event.target.value })
              }
            >
              <option value="GTE">At least</option>
              <option value="LTE">At most</option>
            </select>
          </Field>
          <Field label="Target">
            <Input
              type="number"
              min="0"
              value={draft.target}
              onChange={event =>
                setDraft({ ...draft, target: event.target.value })
              }
            />
          </Field>
        </div>
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={onSave}>Add goal</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
function InstallDialog({ open, setOpen }: any) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install Gold Journal</DialogTitle>
          <DialogDescription>
            Add the journal to your device for a focused, standalone experience.
          </DialogDescription>
        </DialogHeader>
        <div className="install-instructions">
          <p>
            <b>Android / Desktop:</b> use Install App in the browser menu or
            address bar.
          </p>
          <p>
            <b>iPhone / iPad:</b> tap Share, then choose{" "}
            <b>Add to Home Screen</b>.
          </p>
        </div>
        <Button onClick={() => setOpen(false)}>Done</Button>
      </DialogContent>
    </Dialog>
  );
}
function SplashScreen() {
  return (
    <div
      className="splash-screen"
      role="status"
      aria-label="Loading Gold Journal"
    >
      <GoldCanvas className="splash-gold-canvas" data-testid="splash-gold-canvas" />
      <div className="splash-content">
        <GoldMark size={82} />
        <strong>GOLD JOURNAL</strong>
        <span>PRIVATE TRADING INTELLIGENCE</span>
        <div className="loading-line">
          <i />
        </div>
      </div>
    </div>
  );
}
function AuthRecovery({
  error,
  onRetry,
  onReconnect,
}: {
  error: Error | null;
  onRetry: () => void;
  onReconnect: () => void;
}) {
  return (
    <div className="login-screen">
      <section className="login-card query-error" role="alert">
        <ShieldAlert size={28} />
        <span className="eyebrow">SECURE SESSION CHECK FAILED</span>
        <h1>Your sign-in could not be verified.</h1>
        <p>{error?.message || "Supabase Auth is temporarily unavailable."}</p>
        <div className="dialog-actions">
          <Button onClick={onRetry}>
            <RefreshCcw size={15} /> Retry
          </Button>
          <Button variant="outline" onClick={onReconnect}>
            Reconnect session
          </Button>
        </div>
        <small>Your private journal remains unchanged.</small>
      </section>
    </div>
  );
}
export function AuthProfileRecovery({
  error,
  onRetry,
  onReconnect,
  onSignOut,
}: {
  error: { message?: string };
  onRetry: () => void;
  onReconnect: () => void;
  onSignOut: () => void;
}) {
  return (
    <section className="auth-profile-recovery" role="alert">
      <ShieldAlert size={17} />
      <div>
        <strong>Secure profile sync is temporarily unavailable.</strong>
        <span>
          {error.message ||
            "Your sign-in is still present, but the private profile could not be verified."}
        </span>
      </div>
      <Button size="sm" onClick={onRetry}>
        <RefreshCcw size={14} /> Retry
      </Button>
      <Button size="sm" variant="outline" onClick={onReconnect}>
        Reconnect session
      </Button>
      <Button size="sm" variant="outline" onClick={onSignOut}>
        Sign out
      </Button>
    </section>
  );
}
export function LoginScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!supabase) {
      setMessage(
        "Supabase Auth is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
      );
      return;
    }
    if (!email.trim() || password.length < 6) {
      setMessage(
        "Enter a valid email and a password of at least 6 characters."
      );
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result =
        mode === "signin"
          ? await supabase.auth.signInWithPassword({
              email: email.trim(),
              password,
            })
          : await supabase.auth.signUp({
              email: email.trim(),
              password,
              options: { emailRedirectTo: getAuthRedirectUrl() },
            });
      if (result.error) throw result.error;
      setMessage(
        mode === "signup"
          ? "Account created. Check your email if confirmation is enabled, then return here."
          : "Signed in successfully."
      );
    } catch (error: any) {
      setMessage(
        error?.message || "Supabase Auth could not complete the request."
      );
    } finally {
      setBusy(false);
    }
  };
  const magicLink = async () => {
    if (!supabase || !email.trim()) {
      setMessage("Enter your email first.");
      return;
    }
    setBusy(true);
    setMessage("");
    const result = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: getAuthRedirectUrl() },
    });
    setBusy(false);
    setMessage(result.error?.message || "Magic link sent. Check your email.");
  };
  // GSAP owns the login hero choreography: lockup, headline, readout and form
  // stagger in once per mount. Framer Motion is not attached to these nodes, so
  // the two libraries never fight over the same properties.
  const heroRef = useGsapTimeline(root => {
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.fromTo(
      root.querySelectorAll("[data-hero-stage]"),
      { autoAlpha: 0, y: 22 },
      { autoAlpha: 1, y: 0, duration: 0.7, stagger: 0.09 }
    );
    return tl;
  });
  return (
    <div className="login-screen" ref={heroRef}>
      <GoldCanvas className="login-gold-canvas" data-testid="login-gold-canvas" />
      <div className="login-noise" />
      <section className="login-card" data-hero-stage>
        <div className="login-lockup">
          <GoldMark size={58} />
          <div>
            <span>AU / XAUUSD</span>
            <strong>Gold Journal</strong>
          </div>
        </div>
        <span className="eyebrow">PRIVATE PERFORMANCE JOURNAL</span>
        <h1>
          Trade with intent.
          <br />
          <em>Review with truth.</em>
        </h1>
        <p>
          Private execution records for disciplined decisions. Accounts stay
          isolated; every review is yours alone.
        </p>
        <div className="instrument-readout">
          <span>XAUUSD</span>
          <span className="data-text">PKT UTC+5</span>
          <span className="data-text">SUPABASE AUTH</span>
        </div>
        <form className="login-form" onSubmit={submit}>
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete={
                mode === "signin" ? "current-password" : "new-password"
              }
              placeholder="At least 6 characters"
            />
          </Field>
          {message && (
            <div className="login-service-alert" role="alert">
              <ShieldAlert size={16} />
              <div>{message}</div>
            </div>
          )}
          <Button size="lg" type="submit" disabled={busy}>
            {busy
              ? "Connecting…"
              : mode === "signin"
                ? "Enter private journal"
                : "Create private account"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={magicLink}
          >
            Send magic link
          </Button>
        </form>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setMessage("");
          }}
        >
          {mode === "signin"
            ? "Need an account? Create one"
            : "Already registered? Sign in"}
        </button>
        <small>
          Authenticated access · private account data · Supabase-backed
        </small>
      </section>
      <div className="login-footnote">
        <span>GOLD JOURNAL</span>
        <span>AU / XAUUSD JOURNAL</span>
      </div>
    </div>
  );
}
