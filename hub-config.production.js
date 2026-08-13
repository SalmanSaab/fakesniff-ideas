/* Public-safe Hub configuration — PRODUCTION.
 *
 * Claude — 2026-08-13: points at the real FAKESNIFF project. The publishable
 * anon key below is designed to live in browser code; the security boundary is
 * Supabase row-level security plus workspace membership, not this value. It is
 * the same key the public idea board has always shipped.
 *
 * Never put a service-role key in this file. If a key here ever starts with a
 * payload whose role is anything but "anon", it is the wrong key and it is
 * readable by anyone who opens the page.
 */
globalThis.FAKESNIFF_HUB_CONFIG = Object.freeze({
  mode: "connected",
  supabaseUrl: "https://kayxejofqyxoqlberrgw.supabase.co",
  supabasePublishableKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtheXhlam9mcXl4b3FsYmVycmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzMDg0NDQsImV4cCI6MjEwMTg4NDQ0NH0.LFTOsUpdi7Bu9kibW1qYWYcRSLGnF-mWtDlNMYiJe2E",
  workspaceId: "6b9f4ba4-e480-4c08-b67e-4d389db3f9d1"
});
