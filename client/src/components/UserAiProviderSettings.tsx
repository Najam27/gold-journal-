import { useState } from "react";
import { KeyRound, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export function UserAiProviderSettings() {
  const utils = trpc.useUtils();
  const status = trpc.aiSettings.status.useQuery();
  const testKey = trpc.aiSettings.test.useMutation();
  const saveKey = trpc.aiSettings.save.useMutation();
  const removeKey = trpc.aiSettings.remove.useMutation();
  const [key, setKey] = useState("");
  const [model, setModel] = useState("openai/gpt-4o-mini");
  const busy = testKey.isPending || saveKey.isPending || removeKey.isPending;
  const vaultUnavailable = status.data?.vaultAvailable === false;
  const refresh = () => Promise.all([utils.aiSettings.status.invalidate(), utils.analysis.config.invalidate()]);
  const validate = async () => {
    try { const result = await testKey.mutateAsync({ key }); toast.success(`OpenRouter key verified: ${result.label}.`); }
    catch (error) { toast.error(error instanceof Error ? error.message : "OpenRouter could not verify this key."); }
  };
  const save = async () => {
    try { await saveKey.mutateAsync({ key, model }); setKey(""); await refresh(); toast.success("Encrypted AI key saved. It is never shown again."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save AI settings."); }
  };
  const remove = async () => {
    if (!window.confirm("Remove your saved AI key? AI Analysis, Mentor, and Risk Coach will stay unavailable until you add another key.")) return;
    try { await removeKey.mutateAsync({ confirmed: true }); setKey(""); await refresh(); toast.success("Saved AI key removed."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to remove AI settings."); }
  };
  return <section className="panel ai-provider-settings"><span className="section-label">PRIVATE AI PROVIDER</span><h3><KeyRound size={17} /> OpenRouter key</h3><p>Your key is sent only to the authenticated server, encrypted before database storage, and never returned to this browser after save. AI Analysis, AI Mentor, and Risk Coach use this key.</p>{vaultUnavailable ? <p className="ai-key-vault-warning" role="alert">Secure key storage is not enabled on this deployment. Ask the site owner to configure the server encryption secret before adding a key.</p> : status.data?.configured ? <div className="ai-key-status"><ShieldCheck size={16} /><span>Connected as <b>{status.data.maskedKey}</b> · {status.data.model}</span></div> : <p className="muted">No AI key connected. Add your personal OpenRouter key to enable AI features.</p>}<div className="ai-provider-form"><Input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder="sk-or-v1-…" aria-label="OpenRouter API key" disabled={vaultUnavailable} /><Input value={model} onChange={event => setModel(event.target.value)} placeholder="OpenRouter model" aria-label="OpenRouter model" disabled={vaultUnavailable} /><div className="dialog-actions"><Button variant="outline" disabled={vaultUnavailable || busy || key.trim().length < 20} onClick={validate}>{testKey.isPending && <Loader2 className="animate-spin" size={15} />} Test key</Button><Button disabled={vaultUnavailable || busy || key.trim().length < 20 || !model.trim()} onClick={save}>{saveKey.isPending && <Loader2 className="animate-spin" size={15} />} {status.data?.configured ? "Replace key" : "Save key"}</Button>{status.data?.configured && <Button variant="outline" className="danger-button" disabled={vaultUnavailable || busy} onClick={remove}><Trash2 size={15} /> Delete</Button>}</div></div></section>;
}
