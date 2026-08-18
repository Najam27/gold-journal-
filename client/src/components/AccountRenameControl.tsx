import React, { useEffect, useState } from "react";
import { Check, Pencil, Plus, Trash2, Wallet } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { getSelectedAccountId, setSelectedAccountId, subscribeSelectedAccount } from "@/lib/accountSelection";

export function AccountRenameControl() {
  const { isAuthenticated, profileReady } = useAuth();
  const privateReady = profileReady ?? isAuthenticated;
  const [selectedAccountId, setLocalSelectedAccountId] = useState<number | undefined>(() => getSelectedAccountId());
  const journal = trpc.journal.get.useQuery({ accountId: selectedAccountId }, { enabled: Boolean(privateReady && selectedAccountId), retry: false, refetchOnWindowFocus: false });
  const rename = trpc.accounts.rename.useMutation();
  const create = trpc.accounts.create.useMutation();
  const remove = trpc.accounts.remove.useMutation();
  const utils = trpc.useUtils();
  const account = journal.data?.activeAccount;
  const accounts = journal.data?.accounts ?? [];
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [newName, setNewName] = useState("");
  const [removalTarget, setRemovalTarget] = useState<any | null>(null);

  useEffect(() => subscribeSelectedAccount(setLocalSelectedAccountId), []);
  useEffect(() => setName(account?.name || ""), [account?.name]);
  if (!isAuthenticated || !account) return null;

  const refresh = async () => utils.journal.get.invalidate();
  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error("An account name is required."); return; }
    try { await rename.mutateAsync({ accountId: account.id, name: trimmed }); await refresh(); toast.success("Account renamed."); } catch (error: any) { toast.error(error.message || "Account could not be renamed."); }
  };
  const addAccount = async () => {
    const trimmed = newName.trim();
    if (!trimmed) { toast.error("Enter a name for the new account."); return; }
    try { const result = await create.mutateAsync({ name: trimmed, startingBalance: 0 }); setNewName(""); setSelectedAccountId(result.id); await refresh(); toast.success("New trading account created."); } catch (error: any) { toast.error(error.message || "Account could not be created."); }
  };
  const removeAccount = async () => {
    if (!removalTarget) return;
    try { const result = await remove.mutateAsync({ accountId: removalTarget.id, confirmed: true }); setSelectedAccountId(result.replacementAccountId); setRemovalTarget(null); await refresh(); toast.success("Account and its journal records were removed."); } catch (error: any) { toast.error(error.message || "Account could not be removed."); }
  };

  return <><button className="account-rename-fab" onClick={() => setOpen(true)} title="Manage trading accounts"><Wallet size={15} /><span>Manage accounts</span></button><Dialog open={open} onOpenChange={setOpen}><DialogContent className="account-manager-dialog"><DialogHeader><DialogTitle>Trading accounts</DialogTitle><DialogDescription>Create separate journals, switch the active account, rename it, or remove an account only after confirmation.</DialogDescription></DialogHeader><div className="manager-account-list">{accounts.map((item: any) => <button className={item.id === account.id ? "current" : ""} key={item.id} onClick={() => setSelectedAccountId(item.id)}><span><Wallet size={15} />{item.name}</span>{item.id === account.id && <Check size={15} />}</button>)}</div><div className="manager-create-row"><Input value={newName} maxLength={100} onChange={event => setNewName(event.target.value)} placeholder="New account name" /><Button disabled={create.isPending || !newName.trim()} onClick={addAccount}><Plus size={15} />{create.isPending ? "Adding…" : "Add account"}</Button></div><div className="manager-rename-row"><Input value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="Active account name" /><Button variant="outline" disabled={rename.isPending || !name.trim()} onClick={saveName}><Pencil size={14} />{rename.isPending ? "Saving…" : "Rename"}</Button></div><div className="manager-danger"><div><strong>Remove active account</strong><p>Trade records, cash movements, goals, plans, and skipped trades in this account will be permanently removed. At least one other account must remain.</p></div><Button variant="outline" className="danger-button" disabled={accounts.length < 2} onClick={() => setRemovalTarget(account)}><Trash2 size={14} /> Remove</Button></div>{removalTarget && <div className="manager-confirm"><strong>Remove “{removalTarget.name}”?</strong><p>This cannot be undone. A different account will become active.</p><div className="dialog-actions"><Button variant="outline" onClick={() => setRemovalTarget(null)}>Keep account</Button><Button className="danger-button" disabled={remove.isPending} onClick={removeAccount}>{remove.isPending ? "Removing…" : "Confirm removal"}</Button></div></div>}</DialogContent></Dialog></>;
}
