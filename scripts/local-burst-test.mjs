const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const levels = [100, 250, 500, 1000];

async function run(concurrency) {
  const started = performance.now();
  const durations = [];
  let failures = 0;
  let non200 = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    const requestStarted = performance.now();
    try {
      const response = await fetch(`${baseUrl}/api/trpc/auth.me`, { headers: { accept: "application/json" } });
      if (!response.ok) non200 += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    } finally {
      durations.push(performance.now() - requestStarted);
    }
  }));
  durations.sort((a, b) => a - b);
  const percentile = (p) => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] ?? 0;
  return {
    requests: concurrency,
    p50_ms: Number(percentile(0.50).toFixed(2)),
    p95_ms: Number(percentile(0.95).toFixed(2)),
    p99_ms: Number(percentile(0.99).toFixed(2)),
    total_ms: Number((performance.now() - started).toFixed(2)),
    non_2xx: non200,
    network_failures: failures,
  };
}

for (const level of levels) console.log(JSON.stringify(await run(level)));
