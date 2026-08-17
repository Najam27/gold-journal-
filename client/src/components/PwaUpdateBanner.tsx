import { useEffect, useState } from "react";
import { RefreshCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PwaUpdateBanner() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const show = () => setReady(true);
    window.addEventListener("gold-journal-update-ready", show);
    return () => window.removeEventListener("gold-journal-update-ready", show);
  }, []);

  if (!ready) return null;

  const update = async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
    navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
    window.location.reload();
  };

  return <div className="pwa-update-banner"><RefreshCcw size={15} /><span>New version available.</span><Button size="sm" onClick={update}>Update now</Button><button onClick={() => setReady(false)} aria-label="Dismiss update"><X size={15} /></button></div>;
}
