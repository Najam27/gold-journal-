// Authentication screen + Supabase Auth flows.
import { getSupabase, humanError } from "./supabaseClient.js";
import { isConfigured } from "./config.js";
import { toast } from "./ui.js";

function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score; // 0..4
}

export function renderAuth(container) {
  container.innerHTML = `
  <div class="auth-wrap">
    <div class="auth-card glass">
      <div class="auth-brand">
        <div class="brand-mark">AU</div>
        <div>
          <div class="brand-name">Gold Journal</div>
          <div class="brand-sub">XAUUSD trading journal</div>
        </div>
      </div>

      ${
        !isConfigured()
          ? `<div class="config-warn"><i data-lucide="alert-triangle"></i> App configuration missing. Please contact support.</div>`
          : ""
      }

      <div class="auth-tabs">
        <button class="auth-tab active" data-tab="signin">Sign In</button>
        <button class="auth-tab" data-tab="signup">Sign Up</button>
      </div>

      <form id="form-signin" class="auth-form">
        <label class="field">
          <span>Email</span>
          <input type="email" name="email" autocomplete="email" required placeholder="you@example.com">
        </label>
        <label class="field">
          <span>Password</span>
          <div class="pw-wrap">
            <input type="password" name="password" autocomplete="current-password" required placeholder="••••••••">
            <button type="button" class="pw-toggle" aria-label="Show password"><i data-lucide="eye"></i></button>
          </div>
        </label>
        <div class="row-between">
          <a href="#" id="link-forgot" class="link-muted">Forgot password?</a>
        </div>
        <button type="submit" class="btn btn-gold btn-block">
          <span class="btn-label">Sign In</span>
        </button>
      </form>

      <form id="form-signup" class="auth-form hidden">
        <label class="field">
          <span>Email</span>
          <input type="email" name="email" autocomplete="email" required placeholder="you@example.com">
        </label>
        <label class="field">
          <span>Password</span>
          <div class="pw-wrap">
            <input type="password" name="password" autocomplete="new-password" required placeholder="At least 8 characters">
            <button type="button" class="pw-toggle" aria-label="Show password"><i data-lucide="eye"></i></button>
          </div>
          <div class="pw-meter"><span></span></div>
          <div class="pw-hint">Use 8+ chars with an uppercase letter, number &amp; symbol.</div>
        </label>
        <label class="field">
          <span>Confirm password</span>
          <div class="pw-wrap">
            <input type="password" name="confirm" autocomplete="new-password" required placeholder="Re-enter password">
            <button type="button" class="pw-toggle" aria-label="Show password"><i data-lucide="eye"></i></button>
          </div>
        </label>
        <button type="submit" class="btn btn-gold btn-block">
          <span class="btn-label">Create Account</span>
        </button>
      </form>

      <div class="auth-divider"><span>or</span></div>
      <button id="btn-google" class="btn btn-google btn-block">
        <img alt="" src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" width="18" height="18">
        Continue with Google
      </button>
    </div>
    <div class="auth-foot">Cloud-synced across all your devices • Secured by Supabase</div>
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });

  const signin = container.querySelector("#form-signin");
  const signup = container.querySelector("#form-signup");

  container.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      container.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const isSignin = tab.dataset.tab === "signin";
      signin.classList.toggle("hidden", !isSignin);
      signup.classList.toggle("hidden", isSignin);
    });
  });

  container.querySelectorAll(".pw-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = btn.parentElement.querySelector("input");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = `<i data-lucide="${show ? "eye-off" : "eye"}"></i>`;
      window.lucide?.createIcons({ nameAttr: "data-lucide" });
    });
  });

  const pwMeter = signup.querySelector(".pw-meter span");
  signup.querySelector('input[name="password"]').addEventListener("input", (e) => {
    const s = passwordStrength(e.target.value);
    const pct = (s / 4) * 100;
    pwMeter.style.width = pct + "%";
    pwMeter.className = ["", "weak", "fair", "good", "strong"][s] || "";
  });

  const withBusy = async (form, fn) => {
    const btn = form.querySelector('button[type="submit"]');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  };

  signin.addEventListener("submit", (e) => {
    e.preventDefault();
    withBusy(signin, async () => {
      const c = getSupabase();
      if (!c) return toast("Supabase isn't configured.", "error");
      const email = signin.email.value.trim();
      const password = signin.password.value;
      const { error } = await c.auth.signInWithPassword({ email, password });
      if (error) toast(humanError(error), "error");
      else toast("Welcome back!", "success");
    });
  });

  signup.addEventListener("submit", (e) => {
    e.preventDefault();
    withBusy(signup, async () => {
      const c = getSupabase();
      if (!c) return toast("Supabase isn't configured.", "error");
      const email = signup.email.value.trim();
      const password = signup.password.value;
      const confirm = signup.confirm.value;
      if (password !== confirm) return toast("Passwords don't match.", "error");
      if (passwordStrength(password) < 2)
        return toast("Password is too weak — use 8+ chars with a number & uppercase.", "error");
      const { data, error } = await c.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (error) return toast(humanError(error), "error");
      if (data.user && !data.session)
        toast("Account created! Check your email to confirm, then sign in.", "success", 7000);
      else toast("Account created — you're in!", "success");
    });
  });

  container.querySelector("#btn-google").addEventListener("click", async () => {
    const c = getSupabase();
    if (!c) return toast("Supabase isn't configured.", "error");
    const { error } = await c.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname, flowType: "pkce" },
    });
    if (error) toast(humanError(error), "error");
  });

  container.querySelector("#link-forgot").addEventListener("click", (e) => {
    e.preventDefault();
    openReset();
  });
}

function openReset() {
  const email = prompt("Enter your account email to receive a reset link:");
  if (!email) return;
  const c = getSupabase();
  if (!c) return toast("Supabase isn't configured.", "error");
  c.auth
    .resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin + window.location.pathname + "#reset",
    })
    .then(({ error }) => {
      if (error) toast(humanError(error), "error");
      else toast("Password reset link sent — check your inbox.", "success", 6000);
    });
}

export async function signOut() {
  const c = getSupabase();
  if (!c) return;
  await c.auth.signOut();
  toast("Signed out.", "info");
}
