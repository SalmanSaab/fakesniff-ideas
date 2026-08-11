/* Codex — 2026-08-11: invite-only Supabase Auth boundary for the Hub. */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_MODES = new Set(["setup", "connected"]);
const SUPABASE_BROWSER_LIBRARY_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3";
const SUPABASE_BROWSER_LIBRARY_INTEGRITY = "sha384-l8ah+VgaWtk1mvOe9VC+OirC6qHFF4yH7l7mKRidV9MSti3E9F463bMp6ZVN4kuC";

function decodeJwtPayload(value) {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function looksPrivilegedKey(value) {
  if (!value) return false;
  if (/^sb_secret_/i.test(value) || /service[_-]?role/i.test(value)) return true;
  const payload = decodeJwtPayload(value);
  return ["service_role", "supabase_admin"].includes(payload?.role);
}

export function validateHubConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const mode = String(config.mode || "").trim();
  const errors = [];

  if (!ALLOWED_MODES.has(mode)) errors.push("Hub mode must be setup or connected.");
  if (mode === "connected") {
    let supabaseUrl;
    try {
      supabaseUrl = new URL(String(config.supabaseUrl || ""));
      if (
        supabaseUrl.protocol !== "https:"
        || !supabaseUrl.hostname.endsWith(".supabase.co")
        || !["", "/"].includes(supabaseUrl.pathname)
        || supabaseUrl.search
        || supabaseUrl.hash
      ) throw new Error("Standard HTTPS project URL required");
    } catch {
      errors.push("The Supabase project URL is missing or invalid.");
    }
    const publishableKey = String(config.supabasePublishableKey || "").trim();
    if (!publishableKey) errors.push("The Supabase publishable key is missing.");
    if (looksPrivilegedKey(publishableKey)) errors.push("A privileged Supabase key cannot be used in the browser.");
    if (!UUID_PATTERN.test(String(config.workspaceId || ""))) errors.push("The workspace ID is missing or invalid.");
  }

  return {
    ok: errors.length === 0,
    errors,
    config: {
      mode,
      supabaseUrl: String(config.supabaseUrl || "").replace(/\/$/, ""),
      supabasePublishableKey: String(config.supabasePublishableKey || "").trim(),
      workspaceId: String(config.workspaceId || "").trim()
    }
  };
}

function loadSupabaseBrowserLibrary() {
  if (globalThis.supabase?.createClient) return Promise.resolve(globalThis.supabase);
  return new Promise((resolve, reject) => {
    const prior = document.querySelector('script[data-fakesniff-supabase="true"]');
    if (prior) {
      prior.addEventListener("load", () => resolve(globalThis.supabase), { once: true });
      prior.addEventListener("error", () => reject(new Error("Supabase library failed to load.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = SUPABASE_BROWSER_LIBRARY_URL;
    script.integrity = SUPABASE_BROWSER_LIBRARY_INTEGRITY;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.dataset.fakesniffSupabase = "true";
    script.addEventListener("load", () => {
      if (globalThis.supabase?.createClient) resolve(globalThis.supabase);
      else {
        script.remove();
        reject(new Error("Supabase library did not initialize."));
      }
    }, { once: true });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("Supabase library failed to load."));
    }, { once: true });
    document.head.append(script);
  });
}

function cleanRedirectUrl() {
  const redirect = new URL(window.location.href);
  redirect.hash = "";
  redirect.search = "";
  return redirect.href;
}

export async function createHubAuth(config) {
  const library = await loadSupabaseBrowserLibrary();
  const client = library.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "fakesniff-hub-auth"
    }
  });

  return {
    client,
    async getInitialSession() {
      return client.auth.getSession();
    },
    async getVerifiedUser() {
      return client.auth.getUser();
    },
    /* Codex — 2026-08-11: module integrations receive a short-lived token
       accessor, never a copied token that can outlive the active Hub session. */
    async getAccessToken(expectedUserId) {
      const response = await client.auth.getSession();
      if (response.error) throw response.error;
      const session = response.data?.session;
      if (!session?.access_token || !expectedUserId || session.user?.id !== expectedUserId) {
        throw new Error("The active Hub account changed.");
      }
      return session.access_token;
    },
    async requestMagicLink(email) {
      return client.auth.signInWithOtp({
        email: String(email || "").trim().toLowerCase(),
        options: {
          shouldCreateUser: false,
          emailRedirectTo: cleanRedirectUrl()
        }
      });
    },
    onAuthStateChange(callback) {
      return client.auth.onAuthStateChange((event, session) => callback(event, session));
    },
    async signOut() {
      return client.auth.signOut({ scope: "local" });
    }
  };
}
