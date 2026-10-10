import React, { useRef, useState } from "react";
import { Camera, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getPktDateInput, getPktSession } from "@/lib/gold";

export interface QuickTradePayload {
  tradeDate: string;
  session: string;
  direction: "BUY" | "SELL";
  result: "OPEN";
  entryPrice: string;
  slPrice: string;
  tpPrice: string;
  screenshotFile: File | null;
}

/**
 * The 2-minute quick log. Direction, entry, SL, TP, one-tap screenshot,
 * save — details later. The trade lands as OPEN with quickLogged=true so the
 * full dialog can pick it up and finish it. Reuses the same durable
 * screenshot-upload flow as the full dialog (the parent handles upload).
 */
export function QuickTradeDialog({
  open,
  onOpenChange,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (payload: QuickTradePayload) => Promise<void>;
  saving: boolean;
}) {
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");
  const [entryPrice, setEntryPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [tpPrice, setTpPrice] = useState("");
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setDirection("BUY");
    setEntryPrice("");
    setSlPrice("");
    setTpPrice("");
    setScreenshotFile(null);
    // Without this, removing a screenshot and re-attaching the SAME file
    // fires no onChange (the input still holds it) — the attach silently
    // does nothing.
    if (fileRef.current) fileRef.current.value = "";
  };

  const save = async () => {
    await onSave({
      tradeDate: getPktDateInput(),
      session: getPktSession(),
      direction,
      result: "OPEN",
      entryPrice,
      slPrice,
      tpPrice,
      screenshotFile,
    });
    reset();
  };

  // At least one digit required: the old /^\d*\.?\d*$/ also accepted a lone
  // ".", which Number() turns into NaN and the server rejects.
  const price = (value: string) => /^(\d+\.?\d*|\.\d+)?$/.test(value);

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="trade-dialog quick-dialog">
        <DialogHeader>
          <DialogTitle>
            <Timer size={18} /> Quick log
          </DialogTitle>
          <DialogDescription>
            Two minutes, in and out. Direction, entry, stop, target — details
            can wait. The trade saves as open; finish it from the Trade Log.
          </DialogDescription>
        </DialogHeader>
        <div className="quick-grid">
          <div className="quick-direction" role="radiogroup" aria-label="Direction">
            {(["BUY", "SELL"] as const).map(option => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={direction === option}
                className={`quick-direction-btn ${option.toLowerCase()}${direction === option ? " selected" : ""}`}
                onClick={() => setDirection(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <label className="quick-field">
            <span>Entry</span>
            <Input
              type="text"
              inputMode="decimal"
              placeholder="Fill price"
              value={entryPrice}
              onChange={event => { if (price(event.target.value)) setEntryPrice(event.target.value); }}
            />
          </label>
          <label className="quick-field">
            <span>Stop loss</span>
            <Input
              type="text"
              inputMode="decimal"
              placeholder="SL price"
              value={slPrice}
              onChange={event => { if (price(event.target.value)) setSlPrice(event.target.value); }}
            />
          </label>
          <label className="quick-field">
            <span>Take profit</span>
            <Input
              type="text"
              inputMode="decimal"
              placeholder="TP price"
              value={tpPrice}
              onChange={event => { if (price(event.target.value)) setTpPrice(event.target.value); }}
            />
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="quick-file-hidden"
            onChange={event => setScreenshotFile(event.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className={`quick-screenshot${screenshotFile ? " has-file" : ""}`}
            onClick={() => fileRef.current?.click()}
          >
            {screenshotFile ? (
              <>
                <span className="quick-file-name">{screenshotFile.name}</span>
                <X
                  size={14}
                  onClick={event => { event.stopPropagation(); setScreenshotFile(null); }}
                />
              </>
            ) : (
              <>
                <Camera size={16} /> Chart screenshot <small>(optional)</small>
              </>
            )}
          </button>
        </div>
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => { onOpenChange(false); reset(); }} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Log it — 2 min"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
