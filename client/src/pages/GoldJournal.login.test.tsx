// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { signInWithPassword, signUp, signInWithOtp } = vi.hoisted(() => ({ signInWithPassword: vi.fn(), signUp: vi.fn(), signInWithOtp: vi.fn() }));

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { signInWithPassword, signUp, signInWithOtp } } }));
vi.mock("@/lib/trpc", () => ({ trpc: {} }));

import { LoginScreen } from "./GoldJournal";
import { getAuthRedirectUrl } from "@/lib/authRedirect";

describe("Gold Journal Supabase login", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("signs in with email and password", async () => {
    signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
    render(<LoginScreen />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "trader@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secure-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter private journal" }));
    await waitFor(() => expect(signInWithPassword).toHaveBeenCalledWith({ email: "trader@example.com", password: "secure-pass" }));
  });

  it("sends a Supabase magic link", async () => {
    signInWithOtp.mockResolvedValue({ error: null });
    render(<LoginScreen />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "trader@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send magic link" }));
    await waitFor(() => expect(signInWithOtp).toHaveBeenCalledWith({ email: "trader@example.com", options: { emailRedirectTo: getAuthRedirectUrl() } }));
  });
});
