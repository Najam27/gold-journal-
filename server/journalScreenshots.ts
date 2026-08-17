export type ScreenshotTrade<T> = T & { screenshotKey?: string | null };

export async function hydrateSignedScreenshots<T extends { screenshotKey?: string | null }>(rows: T[], sign: (key: string) => Promise<string>, timeoutMs = 1_500, concurrency = 8): Promise<Array<T & { screenshotUrl: string | null }>> {
  const results = new Array<T & { screenshotUrl: string | null }>(rows.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= rows.length) return;
      const row = rows[index];
      if (!row.screenshotKey) {
        results[index] = { ...row, screenshotUrl: null };
        continue;
      }
      const signed = await Promise.race<string | null>([
        sign(row.screenshotKey).catch(() => null),
        new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      results[index] = { ...row, screenshotUrl: signed };
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, rows.length)) }, () => worker()));
  return results;
}
