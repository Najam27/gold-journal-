import React, { useState } from "react";
import { Bell, CheckCheck, Settings2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function NotificationCenter({ triggerClassName = "notification-fab" }: { triggerClassName?: string }) {
  const { isAuthenticated } = useAuth();
  const [open, setOpen] = useState(false);
  const query = trpc.notifications.get.useQuery(undefined, { enabled: isAuthenticated, refetchInterval: 30_000 });
  const updateSettings = trpc.notifications.updateSettings.useMutation();
  const markRead = trpc.notifications.markRead.useMutation();
  const utils = trpc.useUtils();
  if (!isAuthenticated) return null;
  const settings = query.data?.settings ?? { goalAlerts: true, emailAlerts: false };
  const history = query.data?.history ?? [];
  const unread = history.filter((entry: any) => !entry.readAt).length;
  const notificationTitle = (entry: any) => entry.title || (String(entry.type || "").startsWith("GOAL_BREACHED") ? "Goal breached" : String(entry.type || "").startsWith("GOAL_AT_RISK") ? "Goal at risk" : String(entry.type || "").startsWith("GOAL_MET") ? "Goal achieved" : "Journal update");
  const saveSettings = async (patch: Partial<typeof settings>) => { await updateSettings.mutateAsync({ ...settings, ...patch }); await utils.notifications.get.invalidate(); };
  return <><button className={triggerClassName} onClick={() => setOpen(true)} title="Notifications"><Bell size={16} />{unread ? <i>{unread > 9 ? "9+" : unread}</i> : null}</button><Dialog open={open} onOpenChange={setOpen}><DialogContent className="notification-dialog"><DialogHeader><DialogTitle>Journal notifications</DialogTitle><DialogDescription>Control goal alerts and review account-specific journal notifications.</DialogDescription></DialogHeader><section className="notification-settings"><span><Settings2 size={15} /> Alert settings</span><label><input type="checkbox" checked={settings.goalAlerts} onChange={event => saveSettings({ goalAlerts: event.target.checked })} /> Goal alerts</label><label><input type="checkbox" checked={settings.emailAlerts} onChange={event => saveSettings({ emailAlerts: event.target.checked })} /> Email alerts</label></section><section className="notification-history"><div className="notification-history-head"><span>RECENT ACTIVITY</span>{unread ? <Button variant="outline" size="sm" disabled={markRead.isPending} onClick={async () => { await Promise.all(history.filter((entry: any) => !entry.readAt).map((entry: any) => markRead.mutateAsync({ notificationId: entry.id }))); await utils.notifications.get.invalidate(); }}><CheckCheck size={14} /> Mark all read</Button> : null}</div>{history.length ? history.map((entry: any) => <button className={entry.readAt ? "read" : "unread"} key={entry.id} onClick={async () => { if (!entry.readAt) { await markRead.mutateAsync({ notificationId: entry.id }); await utils.notifications.get.invalidate(); } }}><strong>{notificationTitle(entry)}</strong><p>{entry.message || "A journal notification is available."}</p><small>{new Date(entry.createdAt).toLocaleString()}</small></button>) : <p className="muted">No notifications yet. Goal alerts will appear here when recorded.</p>}</section></DialogContent></Dialog></>;
}
