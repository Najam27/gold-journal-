import React, { useEffect, useMemo, useState } from "react";
import { Ban, CheckCircle2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TRADE_OPTION_CATEGORIES, tradeOptionCategory } from "@shared/tradeOptionCategories";
import { duplicateOptionMessage, optionRowsForCategory, useTradeOptionStore, type JournalOption } from "@/lib/tradeOptions";

const DEFAULT_CATEGORY = TRADE_OPTION_CATEGORIES[0].category;

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * The single Trade Log options manager.
 *
 * It is used from the Options page (panel variant), from the floating
 * "Rules & lists" dialog, and from the small gear affordance beside any Trade
 * dialog dropdown, so every entry point manages the same canonical rows.
 *
 * Defaults (seeded rows) and custom rows are treated identically: both can be
 * renamed and both can be disabled/enabled. Nothing is ever deleted.
 */
export function TradeOptionManager({
  variant = "panel",
  initialCategory,
  onClose,
}: {
  variant?: "panel" | "dialog";
  initialCategory?: string;
  onClose?: () => void;
}) {
  const store = useTradeOptionStore();
  const utils = trpc.useUtils();
  const addOption = trpc.optionLists.add.useMutation();
  const renameOption = trpc.optionLists.rename.useMutation();
  const setActive = trpc.optionLists.setActive.useMutation();

  // Accepts either a stable key or a persisted category label, so the gear
  // beside a field can open the manager on exactly that field's category.
  const initial = useMemo(() => tradeOptionCategory(initialCategory ?? "")?.category ?? DEFAULT_CATEGORY, [initialCategory]);
  const [category, setCategory] = useState(initial);
  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState("");
  const [editing, setEditing] = useState<JournalOption | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState("");

  // A gear button beside a dropdown opens the manager already focused on that
  // field's category.
  useEffect(() => setCategory(initial), [initial]);

  const definition = tradeOptionCategory(category) ?? TRADE_OPTION_CATEGORIES[0];
  const rows = useMemo(() => optionRowsForCategory(store.options, category), [store.options, category]);
  const busy = addOption.isPending || renameOption.isPending || setActive.isPending;

  const refresh = async () => {
    await utils.optionLists.list.invalidate();
  };

  const create = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const value = draft.trim();
    if (!value) {
      setFormError("Enter a name for this option.");
      return;
    }
    const duplicate = duplicateOptionMessage(store.options, category, value);
    if (duplicate) {
      setFormError(duplicate);
      return;
    }
    setFormError("");
    try {
      await addOption.mutateAsync({ category, value });
      setDraft("");
      await refresh();
      toast.success(`${value} added to ${definition.label}.`);
    } catch (error) {
      const message = errorMessage(error, `${value} could not be saved.`);
      setFormError(message);
      toast.error(message);
    }
  };

  const openEdit = (option: JournalOption) => {
    setEditing(option);
    setEditValue(option.value);
    setEditError("");
  };

  const saveEdit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!editing) return;
    const value = editValue.trim();
    if (!value) {
      setEditError("Enter a name for this option.");
      return;
    }
    const duplicate = duplicateOptionMessage(
      store.options.filter(option => option.id !== editing.id),
      editing.category,
      value
    );
    if (duplicate) {
      setEditError(duplicate);
      return;
    }
    setEditError("");
    try {
      await renameOption.mutateAsync({ optionId: editing.id, value });
      setEditing(null);
      await refresh();
      toast.success("Option renamed. Saved trades keep the label they were recorded with.");
    } catch (error) {
      const message = errorMessage(error, "The option could not be renamed.");
      setEditError(message);
      toast.error(message);
    }
  };

  const toggleActive = async (option: JournalOption) => {
    try {
      await setActive.mutateAsync({ optionId: option.id, active: !option.active });
      await refresh();
      toast.success(`${option.value} ${option.active ? "disabled" : "enabled"}.`);
    } catch (error) {
      toast.error(errorMessage(error, "The option status could not be changed."));
    }
  };

  return (
    <div className={`trade-option-manager ${variant}`}>
      <div className="trade-option-head">
        <div>
          <h3>Trade Log options</h3>
          <p>Manage every reusable value used in your journal.</p>
        </div>
        {variant === "dialog" && onClose ? (
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </div>

      <div className="trade-option-layout">
        <nav className="trade-option-nav" aria-label="Option categories">
          {TRADE_OPTION_CATEGORIES.map(entry => {
            const count = store.options.filter(option => option.category === entry.category && option.active).length;
            const disabled = store.options.filter(option => option.category === entry.category && !option.active).length;
            return (
              <button
                type="button"
                key={entry.key}
                className={entry.category === category ? "selected" : ""}
                aria-pressed={entry.category === category}
                onClick={() => {
                  setCategory(entry.category);
                  setFormError("");
                }}
              >
                <span>{entry.label}</span>
                <small>
                  {count} active{disabled ? ` · ${disabled} off` : ""}
                </small>
              </button>
            );
          })}
        </nav>

        <section className="trade-option-body" aria-label={`${definition.label} options`}>
          <p className="trade-option-description">{definition.description}</p>

          <form className="trade-option-add" onSubmit={create}>
            <Input
              value={draft}
              aria-label={`Add custom ${definition.category} option`}
              placeholder={`+ Add ${definition.label} option`}
              onChange={event => {
                setDraft(event.target.value);
                if (formError) setFormError("");
              }}
            />
            <Button type="submit" disabled={busy || !draft.trim()}>
              <Plus size={15} /> {addOption.isPending ? "Saving…" : "Add option"}
            </Button>
          </form>
          {formError ? (
            <p className="trade-option-error" role="alert">
              {formError}
            </p>
          ) : null}

          {store.isLoading ? (
            <p className="trade-option-status" role="status">
              Loading options…
            </p>
          ) : store.isError ? (
            <p className="trade-option-error" role="alert">
              Options could not be loaded. Check your connection and try again.
            </p>
          ) : rows.length ? (
            <ul className="trade-option-rows">
              {rows.map(option => (
                <li key={option.id} className={option.active ? "active" : "inactive"}>
                  <span className="trade-option-name">{option.value}</span>
                  <span className={`trade-option-badge ${option.isDefault ? "default" : "custom"}`}>
                    {option.isDefault ? "Default" : "Custom"}
                  </span>
                  <span className={`trade-option-status-badge ${option.active ? "on" : "off"}`}>
                    {option.active ? "Active" : "Disabled"}
                  </span>
                  <span className="trade-option-actions">
                    <button type="button" onClick={() => openEdit(option)} aria-label={`Edit ${option.value}`} title={`Rename ${option.value}`}>
                      <Pencil size={13} /> Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void toggleActive(option)}
                      aria-label={`${option.active ? "Disable" : "Enable"} ${option.value}`}
                      title={`${option.active ? "Disable" : "Enable"} ${option.value}`}
                    >
                      {option.active ? <Ban size={13} /> : <CheckCircle2 size={13} />}
                      {option.active ? "Disable" : "Enable"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="trade-option-status">
              No options in {definition.label} yet. Add one above and it becomes selectable in every trade form immediately.
            </p>
          )}

          <p className="trade-option-note">
            Disabling keeps the option (and every trade that used it) intact — it only disappears from new selections.
          </p>
        </section>
      </div>

      <Dialog
        open={Boolean(editing)}
        onOpenChange={open => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="trade-option-edit-dialog">
          <DialogHeader>
            <DialogTitle>Edit option</DialogTitle>
            <DialogDescription>
              Rename this {editing ? tradeOptionCategory(editing.category)?.label ?? editing.category : "option"}. Trades already saved keep the
              label they were recorded with.
            </DialogDescription>
          </DialogHeader>
          <form className="trade-option-edit-form" onSubmit={saveEdit}>
            <label htmlFor="trade-option-category">Category</label>
            <Input id="trade-option-category" value={editing?.category ?? ""} readOnly aria-readonly="true" />
            <label htmlFor="trade-option-name">Name</label>
            <Input
              id="trade-option-name"
              value={editValue}
              autoFocus
              onChange={event => {
                setEditValue(event.target.value);
                if (editError) setEditError("");
              }}
            />
            {editError ? (
              <p className="trade-option-error" role="alert">
                {editError}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={renameOption.isPending || !editValue.trim()}>
                {renameOption.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
