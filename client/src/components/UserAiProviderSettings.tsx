import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, KeyRound, Loader2, PlugZap, ShieldCheck, Trash2 } from "lucide-react";
import { AI_PROVIDER_META, type AiProviderId } from "@shared/aiCore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clearProviderSettings, readAiProviderBundle, saveProviderSettings } from "@/lib/ai/aiStorage";
import {
  clearAiCache,
  saveProviderKey,
  testProviderConnection,
  type ProviderConnectionStatus,
} from "@/lib/ai/aiService";
import { useAiSettings } from "@/lib/ai/useAiSettings";
import { toast } from "sonner";

/**
 * Private AI provider settings.
 *
 * Providers: Google Gemini and Groq. Both are optional and independent — the
 * user may configure one, both, or neither. Each key is written straight into
 * this browser's local storage and is never transmitted to Gold Journal,
 * Cloudflare, Supabase, or any backend. Outbound AI traffic goes directly from
 * this browser to the provider's own API.
 *
 * The app tries the configured providers in fallback order (Gemini first by
 * default), so a key that is expired, rate-limited, or briefly offline does not
 * disable AI. Model lists are discovered live from the provider with the user's
 * own key, so a retired model is repaired instead of being sent.
 *
 * "Test connection" performs a real model-listing request with the key, so a
 * saved-but-broken credential surfaces here instead of later during an analysis.
 */
function ProviderCard({
  id,
  configured,
  activeProvider,
  maskedKey,
  storedModel,
  draftKey,
  draftModel,
  onKey,
  onModel,
  onTest,
  onSave,
  onSaveModel,
  onRemove,
  connection,
  testing,
  saving,
}: {
  id: AiProviderId;
  configured: boolean;
  activeProvider: AiProviderId | null;
  maskedKey: string | null;
  storedModel: string | null;
  draftKey: string;
  draftModel: string;
  onKey: (value: string) => void;
  onModel: (value: string) => void;
  onTest: () => void;
  onSave: () => void;
  onSaveModel: () => void;
  onRemove: () => void;
  connection: ProviderConnectionStatus | null;
  testing: boolean;
  saving: boolean;
}) {
  const meta = AI_PROVIDER_META[id];
  const availableModels = connection?.models ?? [];
  const busy = testing || saving;
  return (
    <div className="ai-provider-card">
      <div className="ai-provider-card-head">
        <h4>
          <KeyRound size={16} /> {meta.label}
          {activeProvider === id && <span className="ai-provider-badge">PRIMARY</span>}
        </h4>
        {configured ? (
          <div className="ai-key-status">
            <ShieldCheck size={15} />
            <span>
              Saved as <b>{maskedKey}</b> · {storedModel}
            </span>
          </div>
        ) : (
          <p className="muted">Not configured. Add a key to enable this provider.</p>
        )}
      </div>
      {connection && (
        <div className={`ai-connection-status ${connection.ok ? "is-ok" : "is-error"}`} role={connection.ok ? "status" : "alert"}>
          {connection.ok ? <PlugZap size={15} /> : <AlertTriangle size={15} />}
          <span>
            {connection.errorCode ? `${connection.errorCode.replace(/_/g, " ")}: ` : ""}
            {connection.message}
          </span>
        </div>
      )}
      <div className="ai-provider-form">
        <Input
          type="password"
          autoComplete="off"
          value={draftKey}
          onChange={event => onKey(event.target.value)}
          placeholder={meta.keyPlaceholder}
          aria-label={`${meta.label} API key`}
          disabled={busy}
        />
        {availableModels.length > 0 ? (
          <select
            className="ai-model-select"
            value={availableModels.includes(draftModel) ? draftModel : ""}
            onChange={event => onModel(event.target.value)}
            aria-label={`${meta.label} model`}
            disabled={busy}
          >
            {!availableModels.includes(draftModel) && (
              <option value="">{draftModel ? `${draftModel} (unavailable — choose a verified model)` : "Choose a verified model"}</option>
            )}
            {availableModels.map(modelId => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        ) : (
          <Input
            value={draftModel}
            onChange={event => onModel(event.target.value)}
            placeholder={meta.defaultModel}
            aria-label={`${meta.label} model`}
            disabled={busy}
          />
        )}
        <div className="dialog-actions">
          <Button variant="outline" disabled={busy || draftKey.trim().length < 20} onClick={onTest}>
            {testing && <Loader2 className="animate-spin" size={15} />} Test {meta.label} connection
          </Button>
          <Button disabled={busy || draftKey.trim().length < 20 || !draftModel.trim()} onClick={onSave}>
            {saving && <Loader2 className="animate-spin" size={15} />} {configured ? "Replace key" : "Save key"}
          </Button>
          {configured && (
            <Button variant="outline" disabled={busy || !draftModel.trim() || draftModel === storedModel} onClick={onSaveModel}>
              Save model
            </Button>
          )}
          {configured && (
            <Button variant="outline" className="danger-button" disabled={busy} onClick={onRemove}>
              <Trash2 size={15} /> Delete
            </Button>
          )}
        </div>
        <p className="muted">
          Create a free key at{" "}
          <a href={meta.keyUrl} target="_blank" rel="noreferrer">
            {meta.keyUrl.replace(/^https:\/\//, "")}
          </a>
          .
        </p>
      </div>
    </div>
  );
}

export function UserAiProviderSettings() {
  const status = useAiSettings();
  const [drafts, setDrafts] = useState<Record<AiProviderId, { key: string; model: string }>>({
    gemini: { key: "", model: AI_PROVIDER_META.gemini.defaultModel },
    groq: { key: "", model: AI_PROVIDER_META.groq.defaultModel },
  });
  const [connections, setConnections] = useState<Partial<Record<AiProviderId, ProviderConnectionStatus>>>({});
  const [busy, setBusy] = useState<{ provider: AiProviderId; action: "test" | "save" } | null>(null);

  const viewFor = (id: AiProviderId) => status.providers.find(item => item.id === id) ?? null;

  const setDraft = useCallback((id: AiProviderId, patch: Partial<{ key: string; model: string }>) => {
    setDrafts(current => ({ ...current, [id]: { ...current[id], ...patch } }));
  }, []);

  const test = useCallback(
    async (id: AiProviderId, options: { quiet?: boolean } = {}) => {
      const draft = drafts[id];
      const stored = viewFor(id);
      const apiKey = draft.key.trim() || (stored?.configured ? undefined : "");
      if (!apiKey) {
        if (!options.quiet) toast.error(`Enter your ${AI_PROVIDER_META[id].label} API key first.`);
        return;
      }
      setBusy({ provider: id, action: "test" });
      try {
        const result = await testProviderConnection(id, { apiKey, model: draft.model, force: true });
        setConnections(current => ({ ...current, [id]: result }));
        // Only trust a live listing: this is the verified model set for this key.
        if (result.resolvedModel && !result.selectedModelAvailable) {
          setDraft(id, { model: result.resolvedModel });
          if (stored?.configured) {
            try {
              saveProviderKey(id, { apiKey: apiKey!, model: result.resolvedModel });
              toast.warning(`"${result.selectedModel}" is unavailable. Switched to ${result.resolvedModel}.`);
            } catch {
              toast.warning(`"${result.selectedModel}" is unavailable. Select ${result.resolvedModel} and save.`);
            }
          } else if (!options.quiet) {
            toast.warning(`"${result.selectedModel}" is unavailable. ${result.resolvedModel} is preselected.`);
          }
        } else if (!options.quiet) {
          toast[result.ok ? "success" : "error"](result.message);
        }
      } catch (error) {
        if (!options.quiet) toast.error(error instanceof Error ? error.message : `${AI_PROVIDER_META[id].label} could not verify this key.`);
      } finally {
        setBusy(null);
      }
    },
    // `viewFor`/`drafts` change on every render by design; the handler only reads them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts]
  );

  // Show the live connection state on open without asking the user to click.
  useEffect(() => {
    for (const provider of status.providers) {
      if (provider.configured) void test(provider.id, { quiet: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.configured, status.priority.join(","), status.providers.map(item => `${item.id}:${item.maskedKey}:${item.model}`).join(",")]);

  const save = async (id: AiProviderId) => {
    const draft = drafts[id];
    setBusy({ provider: id, action: "save" });
    try {
      saveProviderKey(id, { apiKey: draft.key, model: draft.model || AI_PROVIDER_META[id].defaultModel });
      setDraft(id, { key: "" });
      toast.success(`${AI_PROVIDER_META[id].label} key saved in this browser only. It is never sent to the server.`);
      void test(id, { quiet: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save AI settings.");
    } finally {
      setBusy(null);
    }
  };

  const saveModelOnly = async (id: AiProviderId) => {
    const stored = readAiProviderBundle().providers[id];
    if (!stored) return;
    setBusy({ provider: id, action: "save" });
    try {
      saveProviderSettings(id, { apiKey: stored.apiKey, model: drafts[id].model });
      clearAiCache();
      toast.success(`${AI_PROVIDER_META[id].label} model set to ${drafts[id].model}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save the model.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: AiProviderId) => {
    if (!window.confirm(`Remove your saved ${AI_PROVIDER_META[id].label} key from this browser?`)) return;
    setBusy({ provider: id, action: "save" });
    try {
      clearProviderSettings(id);
      clearAiCache();
      setDraft(id, { key: "" });
      setConnections(current => ({ ...current, [id]: undefined }));
      toast.success(`Local ${AI_PROVIDER_META[id].label} key removed from this browser.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to remove AI settings.");
    } finally {
      setBusy(null);
    }
  };

  const configuredLabel = status.providers
    .filter(provider => provider.configured)
    .map(provider => AI_PROVIDER_META[provider.id].label)
    .join(" → ");

  return (
    <section className="panel ai-provider-settings">
      <span className="section-label">PRIVATE AI PROVIDERS · BROWSER ONLY</span>
      <h3>
        <KeyRound size={17} /> Gemini and Groq API keys
      </h3>
      <p>
        Both providers are optional and independent. Keys are stored in this
        browser&apos;s local storage and are used to call the provider directly from
        this device — they are never sent to Gold Journal, Cloudflare, or Supabase.
        AI Analysis, AI Mentor, and Risk Coach all use them.
      </p>
      <p>
        The app tries your configured providers in order
        {configuredLabel ? ` (currently ${configuredLabel})` : " (Google Gemini, then Groq)"} and
        falls back automatically when one fails, is rate-limited, or has no usable
        model. Model lists are discovered live with your own key, so a retired model
        is repaired automatically. If both providers fail, the complete deterministic
        report is still shown — AI can never take the report away.
      </p>
      <p className="ai-key-local-warning" role="note">
        Local storage is readable by JavaScript running on this site. Only use keys
        you are willing to keep on this device, and remove them when you are done on
        a shared computer.
      </p>
      {!status.persistenceAvailable && (
        <p className="ai-key-vault-warning" role="alert">
          This browser cannot save local AI settings (private mode or blocked
          storage). Enable site storage to configure AI.
        </p>
      )}
      {(["gemini", "groq"] as const).map(id => (
        <ProviderCard
          key={id}
          id={id}
          configured={Boolean(viewFor(id)?.configured)}
          activeProvider={status.activeProvider}
          maskedKey={viewFor(id)?.maskedKey ?? null}
          storedModel={viewFor(id)?.model ?? null}
          draftKey={drafts[id].key}
          draftModel={drafts[id].model}
          onKey={value => setDraft(id, { key: value })}
          onModel={value => setDraft(id, { model: value })}
          onTest={() => void test(id)}
          onSave={() => void save(id)}
          onSaveModel={() => void saveModelOnly(id)}
          onRemove={() => void remove(id)}
          connection={connections[id] ?? null}
          testing={busy?.provider === id && busy.action === "test"}
          saving={busy?.provider === id && busy.action === "save"}
        />
      ))}
    </section>
  );
}
