import { execFileSync } from "node:child_process";

const run = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};
const show = (commit, path) => run("show", `${commit}:${path}`);
const relevant = run(
  "log", "--all", "--reverse", "--format=%H\t%ad\t%s", "--date=short", "--",
  "server/goldRouter.ts", "server/mt5Db.ts", "server/mt5Ingest.ts",
  "client/src/components/Mt5LiveView.tsx", "client/public/GoldJournal_EA.mq5",
  "netlify/functions/api.ts", "netlify.toml", "server/mt5EaDownload.ts", "supabase/migrations"
).trim().split("\n").filter(Boolean);

const yes = value => (value ? "yes" : "no");
console.log("commit\tdate\tkey-create scope\tkey replacement\tconnection delete\tworkspace user filter\tAPI key normalizes owner\tEA fixed endpoint\tsame-origin EA route\tMT5 migrations\tsubject");
for (const line of relevant) {
  const [commit, date, subject] = line.split("\t");
  const router = show(commit, "server/goldRouter.ts");
  const db = show(commit, "server/mt5Db.ts");
  const ea = show(commit, "client/public/GoldJournal_EA.mq5");
  const functionEntry = show(commit, "netlify/functions/api.ts");
  const migrations = run("ls-tree", "-r", "--name-only", commit, "supabase/migrations");
  const createWindow = router.match(/createConnection:[\s\S]{0,1800}/)?.[0] ?? "";
  const scope = createWindow.includes("eq(mt5Connections.userId, ctx.user.id)")
    ? "user+account"
    : createWindow.includes("eq(mt5Connections.accountId, input.accountId)")
      ? "account"
      : "none/other";
  const hasFixedEndpoint = /input string Endpoint\s*=\s*"https:\/\//.test(ea);
  const hasSameOriginRoute = functionEntry.includes("registerMt5EaDownload") || router.includes("registerMt5EaDownload");
  console.log([
    commit.slice(0, 7), date, scope,
    yes(router.includes("replaceConnection:") || router.includes("rotateConnectionKey:")),
    yes(router.includes("delete(mt5Connections)")),
    yes(db.includes("eq(mt5Connections.userId")),
    yes(db.includes("canonicalizeMt5ConnectionOwner")),
    yes(hasFixedEndpoint),
    yes(hasSameOriginRoute),
    yes(migrations.includes("0011_atomic_mt5_history_batch.sql")),
    subject,
  ].join("\t"));
}
