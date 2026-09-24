/**
 * Browser-local persistence for the user's own AI provider keys (Gemini + Groq).
 *
 * The keys are stored in `localStorage` under a namespaced record, but every
 * read/write goes through this abstraction so the storage backend can later be
 * upgraded to IndexedDB + Web Crypto without touching the AI service.
 *
 * Hard rules enforced here:
 *  - a key is never logged, never placed in a URL, never sent to any backend;
 *  - only a masked form is ever exposed to the UI after saving;
 *  - removing a key clears that provider's record completely;
 *  - the retired OpenRouter namespace is deleted, never migrated: that key cannot
 *    work against Gemini or Groq;
 *  - a credential saved under the older single-provider Gemini/Groq namespaces
 *    **is** migrated, because both providers are supported again, so a user who
 *    already stored a key keeps working without re-entering it.
 */
import { AI_PROVIDER_IDS, DEFAULT_AI_MODEL, DEFAULT_GEMINI_MODEL, type AiProviderId } from "@shared/aiCore";
import type { AiSettings, AiSettingsView } from "./aiTypes";

/** The legacy single-provider Groq namespace. Read once, then migrated. */
export const AI_SETTINGS_STORAGE_KEY = "gold-journal.ai.groq:v1";

/** The current dual-provider record. */
export const AI_PROVIDER_STORAGE_KEY = "gold-journal.ai.providers:v1";

/**
 * Retired or legacy provider namespaces.
 *
 * `gold-journal.ai.google:v1` and `gold-journal.ai.groq:v1` are migrated into the
 * dual-provider record (their keys are valid for Gemini and Groq respectively).
 * `gold-journal.ai.openrouter:v1` is purged: OpenRouter is not an offered
 * provider, and its key can never be reinterpreted as a Gemini or Groq key.
 */
export const LEGACY_AI_STORAGE_KEYS = [
  "gold-journal.ai.google:v1",
  "gold-journal.ai.openrouter:v1",
] as const;

export const LEGACY_PROVIDER_KEY_FOR: Record<AiProviderId, string> = {
  gemini: "gold-journal.ai.google:v1",
  groq: AI_SETTINGS_STORAGE_KEY,
};

export const AI_SETTINGS_EVENT = "gold-journal:ai-settings";

/** One provider's stored credential. The key never leaves this browser. */
export type AiProviderSettings = { apiKey: string; model: string; updatedAt: number };

/** The whole browser-local AI configuration. */
export type AiProviderBundle = {
  version: 1;
  /** Preference order used by automatic fallback: first configured wins. */
  priority: AiProviderId[];
  providers: Partial<Record<AiProviderId, AiProviderSettings>>;
};

export const DEFAULT_PROVIDER_PRIORITY: AiProviderId[] = ["gemini", "groq"];

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
      try { return storage()?.getItem(AI_PROVIDER_STORAGE_KEY) ?? null; }
      catch { return null; }
    },
    write: value => {
      try { storage()?.setItem(AI_PROVIDER_STORAGE_KEY, value); }
      catch { throw new Error("This browser cannot store your AI keys locally. Check private-mode or storage settings."); }
    },
    remove: () => {
      try { storage()?.removeItem(AI_PROVIDER_STORAGE_KEY); }
      catch { /* a failed clear must not throw into the UI */ }
    },
    available: () => {
      try {
        const target = storage();
        if (!target) return false;
        const probe = `${AI_PROVIDER_STORAGE_KEY}:probe`;
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

export function assertValidApiKey(key: string, provider: AiProviderId = "groq"): string {
  const clean = key.trim();
  if (clean.length < 20 || clean.length > 512) throw new Error(`Enter a valid ${provider === "gemini" ? "Google Gemini" : "Groq"} API key.`);
  return clean;
}

export function assertValidModel(model: string, provider: AiProviderId = "groq"): string {
  const clean = model.trim();
  if (!clean || clean.length > 160) throw new Error(`Enter a valid ${provider === "gemini" ? "Gemini" : "Groq"} model name.`);
  return clean;
}

export function defaultModelFor(provider: AiProviderId): string {
  return provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_AI_MODEL;
}

function normalizePriority(value: unknown): AiProviderId[] {
  const raw = Array.isArray(value) ? value.map(String) : [];
  const ordered = raw.filter((id): id is AiProviderId => (AI_PROVIDER_IDS as ReadonlyArray<string>).includes(id));
  for (const id of DEFAULT_PROVIDER_PRIORITY) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

function normalizeProvider(value: unknown, provider: AiProviderId): AiProviderSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<AiProviderSettings>;
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  if (apiKey.length < 20) return null;
  const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : defaultModelFor(provider);
  const updatedAt = Number.isFinite(record.updatedAt) ? Number(record.updatedAt) : 0;
  return { apiKey, model, updatedAt };
}

function readLegacyProvider(provider: AiProviderId): AiProviderSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LEGACY_PROVIDER_KEY_FOR[provider]);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return normalizeProvider({ apiKey: parsed.apiKey, model: parsed.model, updatedAt: parsed.updatedAt }, provider);
  } catch {
    return null;
  }
}

function writeBundle(bundle: AiProviderBundle) {
  persistence.write(JSON.stringify(bundle));
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AI_SETTINGS_EVENT));
}

/**
 * One-time migration.
 *
 *  - a saved single-provider Gemini or Groq key is moved into the dual-provider
 *    record, so upgrading never forces a re-entry of a working key;
 *  - the retired OpenRouter namespace is deleted outright.
 */
function migrateLegacySettings(): AiProviderBundle {
  const migrated: Partial<Record<AiProviderId, AiProviderSettings>> = {};
  let changed = false;
  for (const provider of AI_PROVIDER_IDS) {
    const legacy = readLegacyProvider(provider);
    if (legacy) {
      migrated[provider] = legacy;
      changed = true;
    }
    try {
      if (typeof window !== "undefined") window.localStorage.removeItem(LEGACY_PROVIDER_KEY_FOR[provider]);
    } catch { /* best-effort cleanup */ }
  }
  purgeUnsupportedProviderSettings();
  const bundle: AiProviderBundle = { version: 1, priority: DEFAULT_PROVIDER_PRIORITY, providers: migrated };
  if (changed) {
    try { writeBundle(bundle); } catch { /* the migrated values are still returned */ }
  }
  return bundle;
}

/** Deletes credentials for providers this app does not offer. */
export function purgeLegacyProviderSettings() {
  purgeUnsupportedProviderSettings();
}

function purgeUnsupportedProviderSettings() {
  try {
    if (typeof window === "undefined") return;
    for (const key of LEGACY_AI_STORAGE_KEYS) {
      // The Gemini namespace is migrated rather than purged; every other retired
      // namespace is deleted so a foreign key can never be read as a live one.
      if (key === LEGACY_PROVIDER_KEY_FOR.gemini) continue;
      window.localStorage.removeItem(key);
    }
  } catch { /* cleanup is best-effort and must never break startup */ }
}

/** The complete browser-local AI configuration. Never throws. */
export function readAiProviderBundle(): AiProviderBundle {
  const raw = persistence.read();
  if (!raw) return migrateLegacySettings();
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; priority?: unknown; providers?: unknown };
    const source = parsed.providers && typeof parsed.providers === "object" ? (parsed.providers as Record<string, unknown>) : {};
    const providers: Partial<Record<AiProviderId, AiProviderSettings>> = {};
    for (const provider of AI_PROVIDER_IDS) {
      const normalized = normalizeProvider(source[provider], provider);
      if (normalized) providers[provider] = normalized;
    }
    return { version: 1, priority: normalizePriority(parsed.priority), providers };
  } catch {
    return { version: 1, priority: DEFAULT_PROVIDER_PRIORITY, providers: {} };
  }
}

/** Providers that currently hold a credential, in fallback order. */
export function configuredProviderIds(bundle: AiProviderBundle = readAiProviderBundle()): AiProviderId[] {
  return bundle.priority.filter(id => Boolean(bundle.providers[id]));
}

/**
 * The active provider: the first configured one in fallback order, or `null`
 * when no key is stored. This is what legacy single-provider call sites mean by
 * "the configured key".
 */
export function activeProviderId(bundle: AiProviderBundle = readAiProviderBundle()): AiProviderId | null {
  return configuredProviderIds(bundle)[0] ?? null;
}

/** The stored credential of the active provider, or `null` when none is set. */
export function readAiSettings(): (AiSettings & { provider: AiProviderId }) | null {
  const bundle = readAiProviderBundle();
  const provider = activeProviderId(bundle);
  if (!provider) return null;
  const settings = bundle.providers[provider]!;
  return { apiKey: settings.apiKey, model: settings.model, updatedAt: settings.updatedAt, provider };
}

/** Masked view safe to render, for every provider plus the active selection. */
export function readAiSettingsView(): AiSettingsView {
  const bundle = readAiProviderBundle();
  const active = activeProviderId(bundle);
  const available = persistence.available();
  const providers = AI_PROVIDER_IDS.map(id => {
    const settings = bundle.providers[id] ?? null;
    return {
      id,
      configured: Boolean(settings),
      model: settings?.model ?? null,
      maskedKey: settings ? maskApiKey(settings.apiKey) : null,
      updatedAt: settings?.updatedAt || null,
    };
  });
  if (!active) return { configured: false, model: null, maskedKey: null, updatedAt: null, persistenceAvailable: available, providers, priority: bundle.priority, activeProvider: null };
  const settings = bundle.providers[active]!;
  return {
    configured: true,
    model: settings.model,
    maskedKey: maskApiKey(settings.apiKey),
    updatedAt: settings.updatedAt || null,
    persistenceAvailable: available,
    providers,
    priority: bundle.priority,
    activeProvider: active,
  };
}

/** Stores one provider's key + model, leaving every other provider untouched. */
export function saveProviderSettings(provider: AiProviderId, input: { apiKey: string; model: string }): AiSettingsView {
  if (!persistence.available()) throw new Error("This browser cannot store your AI keys locally. Check private-mode or storage settings.");
  const bundle = readAiProviderBundle();
  bundle.providers[provider] = {
    apiKey: assertValidApiKey(input.apiKey, provider),
    model: assertValidModel(input.model, provider),
    updatedAt: Date.now(),
  };
  writeBundle({ ...bundle, version: 1 });
  notify();
  return readAiSettingsView();
}

/** Updates one provider's model without touching its key. */
export function updateProviderModel(provider: AiProviderId, model: string): AiSettingsView {
  const bundle = readAiProviderBundle();
  const current = bundle.providers[provider];
  if (!current) throw new Error(`Add your ${provider === "gemini" ? "Gemini" : "Groq"} API key before choosing a model.`);
  return saveProviderSettings(provider, { apiKey: current.apiKey, model });
}

/** Removes one provider's credential, or every credential when omitted. */
export function clearProviderSettings(provider?: AiProviderId): AiSettingsView {
  if (!provider) {
    persistence.remove();
    notify();
    return readAiSettingsView();
  }
  const bundle = readAiProviderBundle();
  delete bundle.providers[provider];
  writeBundle({ ...bundle, version: 1 });
  notify();
  return readAiSettingsView();
}

/** Sets the fallback preference order (first entry is tried first). */
export function setProviderPriority(priority: AiProviderId[]): AiSettingsView {
  const bundle = readAiProviderBundle();
  writeBundle({ ...bundle, version: 1, priority: normalizePriority(priority) });
  notify();
  return readAiSettingsView();
}

/* ------------------------------------------------------------------ *
 * Legacy single-provider API
 * ------------------------------------------------------------------ *
 * Kept because the Groq settings panel, the tests, and older call sites use it.
 * It now maps onto the Groq entry of the dual-provider record.
 * ------------------------------------------------------------------ */

export function saveAiSettings(input: { apiKey: string; model: string }): AiSettingsView {
  return saveProviderSettings("groq", input);
}

/** Updates the model of the active provider (the one whose key is in use). */
export function updateAiModel(model: string): AiSettingsView {
  const bundle = readAiProviderBundle();
  const provider = activeProviderId(bundle);
  if (!provider) throw new Error("Add an AI provider key before choosing a model.");
  return updateProviderModel(provider, model);
}

/** Removes every stored provider credential. */
export function clearAiSettings(): AiSettingsView {
  return clearProviderSettings();
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
