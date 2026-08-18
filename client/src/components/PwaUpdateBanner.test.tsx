// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PwaUpdateBanner } from "./PwaUpdateBanner";

const postMessage = vi.fn();
const reload = vi.fn();
const waiting = { postMessage };
const registration = { waiting };
const serviceWorker = new EventTarget() as EventTarget & { getRegistration: () => Promise<typeof registration> };
serviceWorker.getRegistration = vi.fn(async () => registration);
Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });

describe("PwaUpdateBanner", () => {
  beforeEach(() => { postMessage.mockReset(); reload.mockReset(); });
  afterEach(() => { document.body.innerHTML = ""; });

  it("waits for the new worker to control the page before one reload", async () => {
    render(<PwaUpdateBanner reload={reload} />);
    act(() => { window.dispatchEvent(new Event("gold-journal-update-ready")); });
    expect(screen.getByText("New version available.")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update now" })); });
    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).not.toHaveBeenCalled();
    await act(async () => { serviceWorker.dispatchEvent(new Event("controllerchange")); });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
