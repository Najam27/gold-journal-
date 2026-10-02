import React, { useEffect, useState } from "react";
import { RefreshCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

let updateInProgress = false;

export function PwaUpdateBanner({ reload = () => window.location.reload() }: { reload?: () => void } = {}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const show = () => setReady(true);
    window.addEventListener("gold-journal-update-ready", show);
    return () => window.removeEventListener("gold-journal-update-ready", show);
  }, []);

  if (!ready) return null;

  const update = async () => {
    if (updateInProgress) return;
    updateInProgress = true;
    const registration = await navigator.serviceWorker.getRegistration();
    const waiting = registration?.waiting;
    if (!waiting) {
      // No parked worker (already activated, or the browser dropped it):
      // a plain reload still lands the user on the newest bundle. Never
      // just hide the banner and strand them on the old one.
      reload();
      return;
    }
    const onControllerChange = () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange, { once: true });
    waiting.postMessage({ type: "SKIP_WAITING" });
  };

  return <div className="pwa-update-banner"><RefreshCcw size={15} /><span>New version available.</span><Button size="sm" onClick={() => void update()}>Update now</Button><button onClick={() => setReady(false)} aria-label="Dismiss update"><X size={15} /></button></div>;
}
