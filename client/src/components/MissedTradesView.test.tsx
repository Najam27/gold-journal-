// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: { skipped: { create: { useMutation: () => ({ mutateAsync: mocks.create, isPending: false }) } } } }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: (props: any) => <textarea {...props} /> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children }: any) => <>{children}</>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogHeader: ({ children }: any) => <header>{children}</header>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));

import { MissedTradesView } from "./MissedTradesView";

describe("MissedTradesView", () => {
  it("opens a blank trader-entered skipped-trade form rather than seeded reason or outcome examples", () => {
    render(<MissedTradesView rows={[]} account={{ id: 1 }} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /log skipped trade/i }));
    expect((screen.getByLabelText("Direction") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Skip reason") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Confidence \(1–5\)") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Outcome") as HTMLInputElement).value).toBe("");
    expect(screen.getByPlaceholderText("Why did you pass this setup?")).toBeTruthy();
    expect(screen.getByPlaceholderText("What happened afterwards?")).toBeTruthy();
  });
});
