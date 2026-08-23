import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commits = git("rev-list", "--all", "--reverse").split("\n").filter(Boolean);
const rules = [
  ["mt5", /(^|\/)(mt5|GoldJournal_EA)|goldRouter\.ts|atomicOperations\.ts/i],
  ["account", /accounts|accountSelection|goldDb\.ts|GoldJournal\.tsx/i],
  ["supabase", /supabase|drizzle|migration|schema\.ts|atomicOperations\.ts/i],
  ["netlify", /netlify|runtimeConfig|server\/_core\/index\.ts/i],
  ["pwa", /client\/public\/sw\.js|manifest\.json|service.?worker/i],
  ["auth", /authSession|useAuth|supabaseAuth|main\.tsx|context\.ts/i],
  ["frontend", /^client\/src\//i],
];

const rows = commits.map(hash => {
  const subject = git("show", "-s", "--format=%ad\t%s", "--date=short", hash);
  const [date, title] = subject.split("\t");
  const files = git("show", "--format=", "--name-only", hash).split("\n").filter(Boolean);
  const tags = rules.filter(([, pattern]) => files.some(file => pattern.test(file))).map(([tag]) => tag);
  return { hash: hash.slice(0, 7), date, title, files, tags };
});

const counts = Object.fromEntries(rules.map(([tag]) => [tag, rows.filter(row => row.tags.includes(tag)).length]));
if (process.argv.includes("--lines")) {
  console.log(`TOTAL\t${rows.length}`);
  console.log(`COUNTS\t${Object.entries(counts).map(([tag, count]) => `${tag}=${count}`).join("\t")}`);
  rows.forEach(row => console.log([row.hash, row.date, row.tags.join(",") || "none", row.title].join("\t")));
} else {
  console.log(JSON.stringify({ total: rows.length, counts, rows }, null, 2));
}
