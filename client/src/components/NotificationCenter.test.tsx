// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateSettings: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn(), invalidate: vi.fn() }));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("@/lib/trpc", () => ({ trpc: { notifications: { get: { useQuery: () => ({ data: { settings: { goalAlerts: true, emailAlerts: false }, history: [{ id: 9, type: "GOAL_AT_RISK_9", title: "", message: "Daily loss threshold is near.", createdAt: new Date("2026-08-12T00:00:00Z"), readAt: null }] } }) }, updateSettings: { useMutation: () => ({ mutateAsync: mocks.updateSettings, isPending: false }) }, markRead: { useMutation: () => ({ mutateAsync: mocks.markRead, isPending: false }) }, markAllRead: { useMutation: () => ({ mutateAsync: mocks.markAllRead, isPending: false }) } }, useUtils: () => ({ notifications: { get: { invalidate: mocks.invalidate } } }) } }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children }: any) => <>{children}</>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogHeader: ({ children }: any) => <div>{children}</div>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));

import { NotificationCenter } from "./NotificationCenter";

describe("NotificationCenter", () => {
  beforeEach(() => { mocks.updateSettings.mockReset(); mocks.markRead.mockReset(); mocks.markAllRead.mockReset(); mocks.invalidate.mockReset(); });
  afterEach(() => cleanup());

  it("renders unread history and saves alert-preference changes", async () => {
    render(<NotificationCenter />);
    fireEvent.click(screen.getByTitle("Notifications"));
    expect(screen.getByText("Goal at risk")).toBeTruthy();
    const goalAlert = screen.getByLabelText("Goal alerts") as HTMLInputElement;
    expect(goalAlert.checked).toBe(true);
    fireEvent.click(goalAlert);
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith({ goalAlerts: false, emailAlerts: false }));
  });

  it("marks all server-side unread notifications rather than only visible rows", async () => {
    render(<NotificationCenter />);
    fireEvent.click(screen.getByTitle("Notifications"));
    fireEvent.click(screen.getByText("Mark all read"));
    await waitFor(() => expect(mocks.markAllRead).toHaveBeenCalledTimes(1));
  });

  it("uses the supplied functional header-trigger class", () => {
    render(<NotificationCenter triggerClassName="icon-button" />);
    expect(screen.getByTitle("Notifications").classList.contains("icon-button")).toBe(true);
  });
});
