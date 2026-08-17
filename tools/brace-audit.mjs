import fs from "node:fs";

const source = fs.readFileSync("/home/ubuntu/pwa-product-app/client/src/pages/GoldJournal.tsx", "utf8");
const stack = [];
let mode = "code";

for (let index = 0; index < source.length; index += 1) {
  const current = source[index];
  const next = source[index + 1];

  if (mode === "code") {
    if (current === "/" && next === "/") { mode = "line"; index += 1; continue; }
    if (current === "/" && next === "*") { mode = "block"; index += 1; continue; }
    if ([39, 34, 96].includes(current.charCodeAt(0))) { mode = current; continue; }
    if (current === "{") stack.push(index);
    if (current === "}") stack.pop();
  } else if (mode === "line") {
    if (current === "\n") mode = "code";
  } else if (mode === "block") {
    if (current === "*" && next === "/") { mode = "code"; index += 1; }
  } else {
    if (current === "\\") { index += 1; continue; }
    if (current === mode) mode = "code";
  }
}

for (const index of stack) {
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  console.log(`Unmatched opening brace at ${line}:${column}`);
}
