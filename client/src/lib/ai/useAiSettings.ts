import { useCallback, useEffect, useState } from "react";
import { readAiSettingsView, subscribeAiSettings } from "./aiStorage";
import type { AiSettingsView } from "./aiTypes";

/**
 * Reactive view of the browser-local AI configuration.
 *
 * Determines configuration from local storage only — no backend request is ever
 * made just to find out whether the user has an AI key.
 */
export function useAiSettings() {
  const [view, setView] = useState<AiSettingsView>(() => readAiSettingsView());
  const refresh = useCallback(() => setView(readAiSettingsView()), []);
  useEffect(() => {
    refresh();
    return subscribeAiSettings(refresh);
  }, [refresh]);
  return { ...view, refresh };
}
