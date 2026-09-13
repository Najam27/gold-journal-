import { useState } from "react";
import { KeyRound, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { AI_MODEL_SUGGESTIONS, DEFAULT_AI_MODEL } from "@shared/aiCore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clearAiSettings, saveAiSettings } from "@/lib/ai/aiStorage";
import { clearAiCache, testAiConnection } from "@/lib/ai/aiService";
import { useAiSettings } from "@/lib/ai/useAiSettings";
import { toast } from "sonner";

/**
 * Private AI provider settings.
 *
 * The Google AI Studio (Gemini) key is written straight into this browser's
 * local storage and is never transmitted to Gold Journal, Cloudflare, Supabase,
 * or any backend. Outbound AI traffic goes directly from this browser to
 * Google's Generative Language API.
 */
export function UserAiProviderSettings() {
  const status = useAiSettings();
  const [key, setKey] = useState("");
  const [model, setModel] = useState(status.model ?? DEFAULT_AI_MODEL);
  const [busy, setBusy] = useState<"test" | "save" | "remove" | null>(null);
  // Models this specific key may call, discovered by the Test key action, so a
  // retired or unavailable model name is easy to replace with a working one.
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  const validate = async () => {
    setBusy("test");
    try {
      const result = await testAiConnection({ apiKey: key });
      setAvailableModels(result.models);
      const hint = result.models.length > 0 && !result.models.includes(model.trim()) ? " Pick one of the listed models." : "";
      toast.success(`Google AI key verified: ${result.label}.${hint}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Google AI could not verify this key.");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      saveAiSettings({ apiKey: key, model: model || DEFAULT_AI_MODEL });
      clearAiCache();
      setKey("");
      toast.success("AI key saved in this browser only. It is never sent to the server.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save AI settings.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm("Remove your saved AI key from this browser? AI Analysis, AI Mentor, and Risk Coach stay unavailable until you add another key.")) return;
    setBusy("remove");
    try {
      clearAiSettings();
      clearAiCache();
      setKey("");
      toast.success("Local AI key removed from this browser.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to remove AI settings.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel ai-provider-settings">
      <span className="section-label">PRIVATE AI PROVIDER · BROWSER ONLY</span>
      <h3>
        <KeyRound size={17} /> Google AI Studio key
      </h3>
      <p>
        Your key is stored in this browser&apos;s local storage and is used to call
        Google AI (Gemini) directly from this device. It is never sent to Gold
        Journal, Cloudflare, or Supabase. AI Analysis, AI Mentor, and Risk Coach
        all use this key. Create a free key at{" "}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
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
      {status.configured ? (
        <div className="ai-key-status">
          <ShieldCheck size={16} />
          <span>
            Connected as <b>{status.maskedKey}</b> · {status.model}
          </span>
        </div>
      ) : (
        <p className="muted">
          No AI key configured. Add your personal Google AI Studio key to enable
          AI features.
        </p>
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
        <Input
          list="ai-model-suggestions"
          value={model}
          onChange={event => setModel(event.target.value)}
          placeholder="Gemini model"
          aria-label="Google AI model"
          disabled={busy !== null}
        />
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
          <Button variant="outline" disabled={busy !== null || key.trim().length < 20} onClick={() => void validate()}>
            {busy === "test" && <Loader2 className="animate-spin" size={15} />} Test key
          </Button>
          <Button
            disabled={!status.persistenceAvailable || busy !== null || key.trim().length < 20 || !model.trim()}
            onClick={() => void save()}
          >
            {busy === "save" && <Loader2 className="animate-spin" size={15} />}{" "}
            {status.configured ? "Replace key" : "Save key"}
          </Button>
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
