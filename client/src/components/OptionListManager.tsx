import React, { useState } from "react";
import { ListChecks } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TradeOptionManager } from "@/components/TradeOptionManager";

/**
 * Floating entry point to the canonical Trade Log option manager.
 *
 * The manager itself is shared with the Options page and with the gear control
 * inside the Trade dialog, so all three surfaces edit the same rows.
 */
export function OptionListManager() {
  const { isAuthenticated, profileReady } = useAuth();
  const privateReady = profileReady ?? isAuthenticated;
  const [open, setOpen] = useState(false);
  if (!privateReady) return null;
  return (
    <>
      <button className="options-fab" onClick={() => setOpen(true)} title="Configure journal lists">
        <ListChecks size={15} />
        <span>Rules &amp; lists</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="option-manager-dialog">
          <DialogHeader>
            <DialogTitle>Trade Log options</DialogTitle>
            <DialogDescription>
              Rename, disable, or add any value used by the Trade Log. Built-in defaults are editable and disabled
              options keep every saved trade intact.
            </DialogDescription>
          </DialogHeader>
          <TradeOptionManager variant="dialog" onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
