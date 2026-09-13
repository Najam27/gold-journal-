/**
 * Browser-local persistence for the user's own Google AI Studio (Gemini) key.
 *
 * The key is stored in `localStorage` under a namespaced key exactly as the
 * product requires, but every read/write goes through this abstraction so the
 * storage backend can later be upgraded to IndexedDB + Web Crypto without
 * touching the AI service.
 *
 * Hard rules enforced here:
 *  - the key is never logged, never placed in a URL, never sent to any backend;
 *  - only a masked form is ever exposed to the UI after saving;
 *  - removing the key clears the record completely.
 */
import { DEFAULT_AI_MODEL } from "@shared/aiCore";
import type { AiSettings, AiSettingsView } from "./aiTypes";

export const AI_SETTINGS_STORAGE_KEY = "gold-journal.ai.google:v1";
/** Pre-Gemini namespace; read once for migration, then removed. */
const LEGACY_OPENROUTER_STORAGE_KEY = "gold-journal.ai.openrouter:v1";
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
  if (clean.length < 20 || clean.length > 512) throw new Error("Enter a valid Google AI Studio API key.");
  return clean;
}

export function assertValidModel(model: string): string {
  const clean = model.trim();
  if (!clean || clean.length > 160) throw new Error("Enter a valid Google AI model name.");
  return clean;
}

/**
 * One-time migration: a previously saved OpenRouter key cannot work against
 * Google's API, so it is discarded rather than mis-used. Its model choice is
 * also provider-specific and dropped with it.
 */
function migrateLegacyOpenRouterSettings() {
  try {
    if (persistence.read() !== null) return;
    if (typeof window === "undefined") return;
    const legacy = window.localStorage.getItem(LEGACY_OPENROUTER_STORAGE_KEY);
    if (legacy !== null) window.localStorage.removeItem(LEGACY_OPENROUTER_STORAGE_KEY);
  } catch { /* migration is best-effort and must never break startup */ }
}

export function readAiSettings(): AiSettings | null {
  migrateLegacyOpenRouterSettings();
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
  if (!current) throw new Error("Add your Google AI Studio API key before choosing a model.");
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
