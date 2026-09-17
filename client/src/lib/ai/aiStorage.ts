/**
 * Browser-local persistence for the user's own Groq API key.
 *
 * The key is stored in `localStorage` under a namespaced key exactly as the
 * product requires, but every read/write goes through this abstraction so the
 * storage backend can later be upgraded to IndexedDB + Web Crypto without
 * touching the AI service.
 *
 * Hard rules enforced here:
 *  - the key is never logged, never placed in a URL, never sent to any backend;
 *  - only a masked form is ever exposed to the UI after saving;
 *  - removing the key clears the record completely;
 *  - a previously stored Gemini (Google AI Studio) or OpenRouter credential is
 *    deleted, never migrated: those keys cannot work against Groq.
 */
import { DEFAULT_AI_MODEL } from "@shared/aiCore";
import type { AiSettings, AiSettingsView } from "./aiTypes";

export const AI_SETTINGS_STORAGE_KEY = "gold-journal.ai.groq:v1";

/**
 * Retired provider namespaces. Their keys are purged on every read so a saved
 * Gemini/OpenRouter credential can never be mis-used as a Groq key and no stale
 * provider configuration survives the migration.
 */
export const LEGACY_AI_STORAGE_KEYS = [
  "gold-journal.ai.google:v1",
  "gold-journal.ai.openrouter:v1",
] as const;

export const AI_SETTINGS_EVENT = "gold-journal:ai-settings";

export interface AiSettingsPersistence {
  read(): string | null;
  write(value: string): void;
  remove(): void;
  available(): boolean;
}

function localStoragePersistence(): AiSettingsPersistence {
  const storage = () => (typeof window === "undefined" ? null : window.localStorage);
  return {
    read: () => {
      try { return storage()?.getItem(AI_SETTINGS_STORAGE_KEY) ?? null; }
      catch { return null; }
    },
    write: value => {
      try { storage()?.setItem(AI_SETTINGS_STORAGE_KEY, value); }
      catch { throw new Error("This browser cannot store your AI key locally. Check private-mode or storage settings."); }
    },
    remove: () => {
      try { storage()?.removeItem(AI_SETTINGS_STORAGE_KEY); }
      catch { /* a failed clear must not throw into the UI */ }
    },
    available: () => {
      try {
        const target = storage();
        if (!target) return false;
        const probe = `${AI_SETTINGS_STORAGE_KEY}:probe`;
        target.setItem(probe, "1");
        target.removeItem(probe);
        return true;
      } catch { return false; }
    },
  };
}

/**
 * In-memory backend used by tests and by environments without `localStorage`.
 * Credentials never persist beyond the process, which is the safe default.
 */
export function memoryAiSettingsPersistence(seed?: string): AiSettingsPersistence {
  let value: string | null = seed ?? null;
  return {
    read: () => value,
    write: next => { value = next; },
    remove: () => { value = null; },
    available: () => true,
  };
}

let persistence: AiSettingsPersistence = localStoragePersistence();

/** Swap the storage backend (e.g. IndexedDB + Web Crypto). Test seam too. */
export function setAiSettingsPersistence(next: AiSettingsPersistence) {
  persistence = next;
}
export function resetAiSettingsPersistence() {
  persistence = localStoragePersistence();
}
export function aiPersistenceAvailable() {
  return persistence.available();
}

export function maskApiKey(key: string): string {
  const clean = key.trim();
  if (clean.length <= 10) return "••••••••";
  return `${clean.slice(0, 8)}••••••••${clean.slice(-4)}`;
}

export function assertValidApiKey(key: string): string {
  const clean = key.trim();
  if (clean.length < 20 || clean.length > 512) throw new Error("Enter a valid Groq API key.");
  return clean;
}

export function assertValidModel(model: string): string {
  const clean = model.trim();
  if (!clean || clean.length > 160) throw new Error("Enter a valid Groq model name.");
  return clean;
}

/**
 * One-time cleanup: Gemini (Google AI Studio) and OpenRouter keys belong to
 * different providers, so they are deleted rather than migrated. The user
 * starts with "Groq not configured" until they add a Groq key.
 */
export function purgeLegacyProviderSettings() {
  try {
    if (typeof window === "undefined") return;
    for (const key of LEGACY_AI_STORAGE_KEYS) window.localStorage.removeItem(key);
  } catch { /* cleanup is best-effort and must never break startup */ }
}

export function readAiSettings(): AiSettings | null {
  purgeLegacyProviderSettings();
  const raw = persistence.read();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_AI_MODEL;
    const updatedAt = Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : 0;
    if (apiKey.length < 20) return null;
    return { apiKey, model, updatedAt };
  } catch {
    return null;
  }
}

/** Masked view safe to render. */
export function readAiSettingsView(): AiSettingsView {
  const settings = readAiSettings();
  const available = persistence.available();
  if (!settings) return { configured: false, model: null, maskedKey: null, updatedAt: null, persistenceAvailable: available };
  return { configured: true, model: settings.model, maskedKey: maskApiKey(settings.apiKey), updatedAt: settings.updatedAt || null, persistenceAvailable: available };
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AI_SETTINGS_EVENT));
}

export function saveAiSettings(input: { apiKey: string; model: string }): AiSettingsView {
  if (!persistence.available()) throw new Error("This browser cannot store your AI key locally. Check private-mode or storage settings.");
  const settings: AiSettings = { apiKey: assertValidApiKey(input.apiKey), model: assertValidModel(input.model), updatedAt: Date.now() };
  persistence.write(JSON.stringify(settings));
  notify();
  return readAiSettingsView();
}

export function updateAiModel(model: string): AiSettingsView {
  const current = readAiSettings();
  if (!current) throw new Error("Add your Groq API key before choosing a model.");
  return saveAiSettings({ apiKey: current.apiKey, model });
}

export function clearAiSettings(): AiSettingsView {
  persistence.remove();
  notify();
  return readAiSettingsView();
}

export function subscribeAiSettings(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(AI_SETTINGS_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(AI_SETTINGS_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
