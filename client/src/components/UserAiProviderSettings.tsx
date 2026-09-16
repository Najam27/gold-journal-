import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, KeyRound, Loader2, PlugZap, ShieldCheck, Trash2 } from "lucide-react";
import { AI_MODEL_SUGGESTIONS, AI_PROVIDER_LABEL, AI_PROVIDER_URL, DEFAULT_AI_MODEL } from "@shared/aiCore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clearAiSettings, saveAiSettings, updateAiModel } from "@/lib/ai/aiStorage";
import { checkGeminiConnection, clearAiCache, type GeminiConnectionStatus } from "@/lib/ai/aiService";
import { useAiSettings } from "@/lib/ai/useAiSettings";
import { toast } from "sonner";

/**
 * Private AI provider settings.
 *
 * Provider: Gemini (Google AI Studio) — the only provider in the app.
 *
 * The key is written straight into this browser's local storage and is never
 * transmitted to Gold Journal, Cloudflare, Supabase, or any backend. Outbound AI
 * traffic goes directly from this browser to Google's Generative Language API.
 *
 * Before any analysis runs, the app lists the models this specific key can
 * actually call, so a retired or unsupported model is caught here rather than
 * surfacing later as a model error.
 */
export function UserAiProviderSettings() {
  const status = useAiSettings();
  const [key, setKey] = useState("");
  const [model, setModel] = useState(status.model ?? DEFAULT_AI_MODEL);
  const [busy, setBusy] = useState<"test" | "save" | "remove" | null>(null);
  // Models this specific key may call, discovered by Test Gemini Connection, so
  // a retired or unavailable model name is easy to replace with a working one.
  const [connection, setConnection] = useState<GeminiConnectionStatus | null>(null);

  const availableModels = connection?.models ?? [];

  const test = useCallback(
    async (options: { apiKey?: string; force?: boolean; quiet?: boolean } = {}) => {
      setBusy("test");
      try {
        const result = await checkGeminiConnection({ apiKey: options.apiKey ?? key, model, force: options.force });
        setConnection(result);
        // Only trust a live listing: this is the verified model set for this key.
        if (result.resolvedModel && !result.selectedModelAvailable) {
          setModel(result.resolvedModel);
          if (status.configured) {
            try {
              updateAiModel(result.resolvedModel);
              toast.warning(`"${result.selectedModel}" is unavailable. Switched to ${result.resolvedModel}.`);
            } catch {
              toast.warning(`"${result.selectedModel}" is unavailable. Select ${result.resolvedModel} and save.`);
            }
          } else {
            toast.warning(`"${result.selectedModel}" is unavailable. ${result.resolvedModel} is preselected.`);
          }
        } else if (!options.quiet) {
          toast[result.ok ? "success" : "error"](result.message);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Gemini could not verify this key.");
      } finally {
        setBusy(null);
      }
    },
    [key, model, status.configured]
  );

  // Show the live connection state on open without asking the user to click.
  useEffect(() => {
    if (!status.configured) return;
    void test({ quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.configured, status.maskedKey, status.model]);

  const save = async () => {
    setBusy("save");
    try {
      saveAiSettings({ apiKey: key, model: model || DEFAULT_AI_MODEL });
      clearAiCache();
      setKey("");
      toast.success("Gemini key saved in this browser only. It is never sent to the server.");
      void test({ quiet: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save AI settings.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm("Remove your saved Gemini key from this browser? AI Analysis, AI Mentor, and Risk Coach stay unavailable until you add another key.")) return;
    setBusy("remove");
    try {
      clearAiSettings();
      clearAiCache();
      setKey("");
      setConnection(null);
      toast.success("Local Gemini key removed from this browser.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to remove AI settings.");
    } finally {
      setBusy(null);
    }
  };

  const saveModelOnly = async () => {
    setBusy("save");
    try {
      updateAiModel(model);
      clearAiCache();
      toast.success(`Gemini model set to ${model}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save the model.");
    } finally {
      setBusy(null);
    }
  };

  const connectionState = !status.configured && !key.trim() ? null : connection;
  const testing = busy === "test";

  return (
    <section className="panel ai-provider-settings">
      <span className="section-label">PRIVATE AI PROVIDER · BROWSER ONLY</span>
      <h3>
        <KeyRound size={17} /> {AI_PROVIDER_LABEL} API key
      </h3>
      <p>
        Your key is stored in this browser&apos;s local storage and is used to call
        Google AI ({AI_PROVIDER_LABEL}) directly from this device. It is never sent to Gold
        Journal, Cloudflare, or Supabase. AI Analysis, AI Mentor, and Risk Coach
        all use this one key. Create a free key at{" "}
        <a href={AI_PROVIDER_URL} target="_blank" rel="noreferrer">
          aistudio.google.com/apikey
        </a>
        .
      </p>
      <p className="ai-key-local-warning" role="note">
        Local storage is readable by JavaScript running on this site. Only use a
        key you are willing to keep on this device, and remove it when you are
        done on a shared computer.
      </p>
      {!status.persistenceAvailable && (
        <p className="ai-key-vault-warning" role="alert">
          This browser cannot save local AI settings (private mode or blocked
          storage). Enable site storage to configure AI.
        </p>
      )}
      <div className="ai-provider-summary">
        <span>
          Provider <b>{AI_PROVIDER_LABEL}</b>
        </span>
        <span>
          Model <b>{status.model ?? DEFAULT_AI_MODEL}</b>
        </span>
      </div>
      {status.configured ? (
        <div className="ai-key-status">
          <ShieldCheck size={16} />
          <span>
            Connected as <b>{status.maskedKey}</b> · {status.model}
          </span>
        </div>
      ) : (
        <p className="muted">
          No Gemini key configured. Add your personal Google AI Studio key to
          enable AI features.
        </p>
      )}
      {connectionState && (
        <div
          className={`ai-connection-status ${connectionState.ok ? "is-ok" : "is-error"}`}
          role={connectionState.ok ? "status" : "alert"}
        >
          {connectionState.ok ? <PlugZap size={15} /> : <AlertTriangle size={15} />}
          <span>{connectionState.errorCode ? `${connectionState.errorCode.replace(/_/g, " ")}: ` : ""}{connectionState.message}</span>
        </div>
      )}
      <div className="ai-provider-form">
        <Input
          type="password"
          autoComplete="off"
          value={key}
          onChange={event => setKey(event.target.value)}
          placeholder="AIza…"
          aria-label="Google AI Studio API key"
          disabled={busy !== null}
        />
        {availableModels.length > 0 ? (
          <select
            className="ai-model-select"
            value={availableModels.includes(model) ? model : ""}
            onChange={event => setModel(event.target.value)}
            aria-label="Gemini model"
            disabled={busy !== null}
          >
            {!availableModels.includes(model) && (
              <option value="">{model ? `${model} (unavailable — choose a verified model)` : "Choose a verified Gemini model"}</option>
            )}
            {availableModels.map(id => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : (
          <Input
            list="ai-model-suggestions"
            value={model}
            onChange={event => setModel(event.target.value)}
            placeholder="Gemini model"
            aria-label="Gemini model"
            disabled={busy !== null}
          />
        )}
        <datalist id="ai-model-suggestions">
          {AI_MODEL_SUGGESTIONS.map(option => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          {availableModels
            .filter(id => !AI_MODEL_SUGGESTIONS.some(option => option.id === id))
            .map(id => (
              <option key={id} value={id}>
                Available with your key
              </option>
            ))}
        </datalist>
        <div className="dialog-actions">
          <Button
            variant="outline"
            disabled={busy !== null || key.trim().length < 20}
            onClick={() => void test({ force: true })}
          >
            {testing && <Loader2 className="animate-spin" size={15} />} Test Gemini Connection
          </Button>
          <Button
            disabled={!status.persistenceAvailable || busy !== null || key.trim().length < 20 || !model.trim()}
            onClick={() => void save()}
          >
            {busy === "save" && <Loader2 className="animate-spin" size={15} />}{" "}
            {status.configured ? "Replace key" : "Save key"}
          </Button>
          {status.configured && (
            <Button
              variant="outline"
              disabled={busy !== null || !model.trim() || model === status.model}
              onClick={() => void saveModelOnly()}
            >
              Save model
            </Button>
          )}
          {status.configured && (
            <Button variant="outline" className="danger-button" disabled={busy !== null} onClick={() => void remove()}>
              <Trash2 size={15} /> Delete
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
