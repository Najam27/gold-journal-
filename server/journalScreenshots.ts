export type ScreenshotTrade<T> = T & { screenshotKey?: string | null };

export async function hydrateSignedScreenshots<T extends { screenshotKey?: string | null }>(rows: T[], sign: (key: string) => Promise<string>, timeoutMs = 1_500): Promise<Array<T & { screenshotUrl: string | null }>> {
  return Promise.all(rows.map(async row => {
    if (!row.screenshotKey) return { ...row, screenshotUrl: null };
    const signed = await Promise.race<string | null>([
      sign(row.screenshotKey).catch(() => null),
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return { ...row, screenshotUrl: signed };
  }));
}
