/* Public-safe Hub configuration. Never put a service-role key in this file.
 *
 * Claude — 2026-08-12: pointed at the THROWAWAY STAGING project for testing.
 * The publishable/anon key is designed to live in browser code; the security
 * boundary is Supabase row-level security plus workspace membership, not this
 * value. Switch supabaseUrl/supabasePublishableKey to production only when we
 * deliberately go live.
 */
globalThis.FAKESNIFF_HUB_CONFIG = Object.freeze({
  mode: "connected",
  supabaseUrl: "https://ojbxrtxhlnmapdrwmaod.supabase.co",
  supabasePublishableKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qYnhydHhobG5tYXBkcndtYW9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0ODM4OTcsImV4cCI6MjEwMjA1OTg5N30.KyUoleUht0E4Histothli4eIkcRGzU5jq3swWD8BtT4",
  workspaceId: "6b9f4ba4-e480-4c08-b67e-4d389db3f9d1"
});
