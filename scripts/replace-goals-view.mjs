import { readFileSync, writeFileSync } from "node:fs";

const file = "client/src/pages/GoldJournal.tsx";
let source = readFileSync(file, "utf8");

source = source.replace('import { ProfessionalGoalsView } from "@/components/ProfessionalGoalsView";', 'import { FlexibleGoalsView } from "@/components/FlexibleGoalsView";');
source = source.replace('const [missedDialog, setMissedDialog] = useState(false); const [goalDialog, setGoalDialog] = useState(false); const [goalDraft, setGoalDraft] = useState({ name: "", description: "", period: "DAILY", metric: "trade_count", comparison: "LTE", target: "3" });', 'const [missedDialog, setMissedDialog] = useState(false);');
source = source.replace('const createGoal = trpc.goals.create.useMutation(); const updateGoal = trpc.goals.update.useMutation(); const deleteGoal = trpc.goals.delete.useMutation(); const createAccount', 'const createGoal = trpc.goals.create.useMutation(); const updateGoal = trpc.goals.update.useMutation(); const deleteGoal = trpc.goals.delete.useMutation(); const clearGoals = trpc.goals.clearAll.useMutation(); const createAccount');
source = source.replace('const GoalsView = ProfessionalGoalsView;', 'const GoalsView = FlexibleGoalsView;');

const goalsView = `{view === "goals" && <GoalsView account={account} goals={data?.goals ?? []} trades={trades} plans={data?.dailyPlans ?? []} pending={createGoal.isPending || updateGoal.isPending || deleteGoal.isPending || clearGoals.isPending} onCreate={async draft => { if (!account) return; await createGoal.mutateAsync({ accountId: account.id, ...draft }); toast.success("Goal created."); refresh(); }} onUpdate={async goal => { if (!account) return; await updateGoal.mutateAsync({ accountId: account.id, ...goal }); toast.success("Goal updated."); refresh(); }} onDelete={async goal => { await deleteGoal.mutateAsync({ goalId: goal.id }); toast.success("Goal deleted."); refresh(); }} onClear={async () => { if (!account) return; await clearGoals.mutateAsync({ accountId: account.id, confirmed: true }); toast.success("All account goals removed."); refresh(); }} />}`;
source = source.replace(/\{view === "goals" && <GoalsView[\s\S]*?\/>\}/, goalsView);
source = source.replace(/<GoalDialog[\s\S]*?\/><InstallDialog/, '<InstallDialog');

if (source.includes("ProfessionalGoalsView") || source.includes("goalDialog") || source.includes("<GoalDialog")) throw new Error("Legacy goals replacement was incomplete.");
if (!source.includes("FlexibleGoalsView") || !source.includes("clearGoals")) throw new Error("Flexible goal wiring was not added.");
writeFileSync(file, source);
