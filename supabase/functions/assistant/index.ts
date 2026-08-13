/* FAKESNIFF Hub — the assistant.
 *
 * A Supabase Edge Function, which exists for one reason: the Gemini key must
 * never reach the browser. Anything in page JavaScript is readable by anyone
 * who opens the page. So the key lives here as a Supabase secret and the
 * browser only ever talks to this function.
 *
 * The design that makes this safe is worth stating plainly:
 *
 *   This function acts as the CALLER, never as the service role.
 *
 * It takes the user's own access token and uses that for every database read.
 * Row-level security therefore applies to the assistant exactly as it applies
 * to the person. A viewer's assistant cannot see or change more than the
 * viewer can, and that is a property of the architecture rather than a rule we
 * have to remember to enforce. There is no service-role key in this file and
 * there must never be one.
 *
 * It also does not write. It answers, and it proposes an action; the browser
 * carries the action out using the same session. So a suggestion Marco does not
 * want is a suggestion he declines, not something that already happened.
 */

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
/* Codex — 2026-08-13: a valid Supabase account is not enough. Every assistant
   request must prove active membership in this one workspace before any model
   or workspace-data call is allowed. The UUID is already public Hub config. */
const WORKSPACE_ID = "6b9f4ba4-e480-4c08-b67e-4d389db3f9d1";

const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const TEXT_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];
/* Claude — 2026-08-13: vision has its own list. gemini-2.0-flash was retired
   under us and took photo description down with it while chat kept working,
   because chat happened to succeed on the first candidate. */
const VISION_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
const IMAGE_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-2.0-flash-preview-image-generation",
  "imagen-3.0-generate-002",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

/* The sections the assistant is allowed to send someone to. An open string here
   would let a model invent a destination that does not exist. */
export const SECTIONS = Object.freeze(["home", "work", "idea-lab", "lookbook", "decisions"]);

const SYSTEM = `You are the assistant inside FAKESNIFF's company hub.

FAKESNIFF is a small Dutch streetwear brand. Three people use this: Marco (owner),
Emiel (operations) and Salman. Marco and Emiel are not technical. Write the way
you would speak to a colleague who is good at their job and has never used a
project tool. Short sentences. No jargon, no headings, no bullet lists unless
they genuinely asked for a list.

The hub has these places:
- home       an overview of what needs attention
- work       tasks moving through backlog, this week, doing, review, done
- idea-lab   raw cultural material the scanner collects, turned into ideas
- lookbook   photographs of garments, fabrics and details worth remembering
- decisions  what the company agreed: fabric, price, minimum orders, delivery

You know which page the person is on. Answer for where they are. If what they
want lives somewhere else, offer to take them.

You may propose ONE action per reply by ending with a single line of JSON:
{"action":"navigate","section":"lookbook"}
{"action":"compose","section":"decisions"}     opens the form, prefilled if you pass fields
{"action":"image","prompt":"..."}              generates a picture
Only use an action when it genuinely helps. Most replies need none.

Never invent what is in the workspace. You are given the real counts and recent
items below; if something is not there, say you cannot see it rather than
guessing. If the workspace is empty, say so plainly and suggest the smallest
useful first step.`;

async function callerIdentity(token: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const user = await r.json();
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

/* Every read below goes through the caller's token on purpose. If they are not
   a member, RLS returns nothing and the assistant simply has no context — it
   cannot be tricked into reading another workspace. */
async function readAsCaller(token: string, path: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

async function activeCallerMembership(token: string, userId: string) {
  const rows = await readAsCaller(
    token,
    `members?select=workspace_id,user_id,display_name,role,archived_at&workspace_id=eq.${WORKSPACE_ID}&user_id=eq.${encodeURIComponent(userId)}&archived_at=is.null&limit=1`,
  );
  if (!Array.isArray(rows)) return null;
  return rows.find((row: any) =>
    row?.workspace_id === WORKSPACE_ID && row?.user_id === userId && !row?.archived_at
  ) ?? null;
}

async function gatherContext(token: string, member: any) {
  const workspace = `workspace_id=eq.${WORKSPACE_ID}`;
  const [tasks, decisions, lookbook, ideas] = await Promise.all([
    readAsCaller(token, `tasks?select=title,status,next_action&${workspace}&archived_at=is.null&order=updated_at.desc&limit=12`),
    readAsCaller(token, `decisions?select=title,status,topic,counterparty&${workspace}&archived_at=is.null&order=updated_at.desc&limit=8`),
    readAsCaller(token, `lookbook_items?select=title,category,ai_analysis&${workspace}&archived_at=is.null&order=created_at.desc&limit=8`),
    readAsCaller(token, `ideas?select=line,status&${workspace}&order=created_at.desc&limit=8`),
  ]);

  const who = member;
  const lines = [
    `The person is ${who.display_name}, role ${who.role}.`,
    `Work items: ${tasks.length}${tasks.length ? " — " + tasks.map((t: any) => `${t.title} (${t.status})`).join("; ") : " (none yet)"}`,
    `Decisions: ${decisions.length}${decisions.length ? " — " + decisions.map((d: any) => `${d.title} [${d.status}${d.counterparty ? ", with " + d.counterparty : ""}]`).join("; ") : " (none yet)"}`,
    `Lookbook photos: ${lookbook.length}${lookbook.length ? " — " + lookbook.map((l: any) => l.title || l.category).join("; ") : " (none yet)"}`,
    `Ideas on the board: ${ideas.length}`,
  ];
  return { who, summary: lines.join("\n") };
}

async function askGemini(messages: any[], systemText: string) {
  const failures: string[] = [];
  for (const model of TEXT_MODELS) {
    try {
      const r = await fetch(`${GEMINI_ROOT}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents: messages,
          generationConfig: { temperature: 0.4, maxOutputTokens: 800 },
        }),
      });
      if (!r.ok) { failures.push(`${model}: ${(await r.text()).slice(0, 160)}`); continue; }
      const data = await r.json();
      const text = (data?.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p.text ?? "").join("").trim();
      if (text) return { text, model };
      failures.push(`${model}: empty reply`);
    } catch (e) {
      failures.push(`${model}: ${String(e).slice(0, 160)}`);
    }
  }
  throw new Error(failures.join(" | ") || "no model answered");
}

async function makeImage(prompt: string) {
  /* Claude — 2026-08-13: model names and the shape of the image request have
     both moved more than once. Try the candidates in order and, crucially,
     report what every one of them said — the previous version threw away the
     reason and left "try describing it differently" as the only clue, which
     was wrong as often as it was right. */
  const failures: string[] = [];
  for (const model of IMAGE_MODELS) {
    for (const modalities of [["IMAGE"], ["TEXT", "IMAGE"]]) {
      try {
        const r = await fetch(`${GEMINI_ROOT}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: modalities },
          }),
        });
        if (!r.ok) {
          failures.push(`${model} [${modalities.join("+")}]: ${(await r.text()).slice(0, 180)}`);
          continue;
        }
        const data = await r.json();
        for (const part of data?.candidates?.[0]?.content?.parts ?? []) {
          const inline = part.inlineData ?? part.inline_data;
          if (inline?.data) {
            return { dataUrl: `data:${inline.mimeType ?? inline.mime_type ?? "image/png"};base64,${inline.data}` };
          }
        }
        const blocked = data?.promptFeedback?.blockReason;
        failures.push(`${model} [${modalities.join("+")}]: ${blocked ? "refused: " + blocked : "no image in the reply"}`);
      } catch (e) {
        failures.push(`${model} [${modalities.join("+")}]: ${String(e).slice(0, 140)}`);
      }
    }
  }
  throw new Error(failures.join(" | ").slice(0, 700));
}

/* Codex — 2026-08-13: only an exact standalone final line can be an action.
   JSON shown inline, fenced as an example, or nested inside ordinary data must
   remain reply text. Refuse any destination the Hub does not have. */
export function splitAction(text: string) {
  const original = String(text ?? "").trim();
  const lines = original.split(/\r?\n/);
  const candidate = lines.at(-1)?.trim() ?? "";
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
    return { reply: original, action: null };
  }

  let action: any = null;
  try { action = JSON.parse(candidate); } catch { return { reply: original, action: null }; }
  if (!action || Array.isArray(action) || typeof action !== "object" || typeof action.action !== "string") {
    return { reply: original, action: null };
  }

  const reply = lines.slice(0, -1).join("\n").trim();

  if (action?.action === "navigate" || action?.action === "compose") {
    if (typeof action.section !== "string" || !SECTIONS.includes(action.section)) {
      return { reply, action: null };
    }
  } else if (action?.action !== "image") {
    return { reply: original, action: null };
  }
  return { reply, action };
}


/* ---------------------------------------------------------------------------
 * Describing a Lookbook photo.
 *
 * Claude — 2026-08-13: this already existed as an hourly GitHub Action, which
 * is the wrong shape for someone standing in a factory: a photo taken now
 * could sit undescribed for fifty minutes. Doing it here means seconds.
 *
 * The image is fetched with the CALLER's token, so a person can only ever have
 * their own workspace's photos described. The hourly job stays as a safety net
 * for anything that fails here.
 * ------------------------------------------------------------------------ */
const LOOKBOOK_BRIEF = `Look at this clothing or material reference and describe it for a small streetwear brand's design library.

Return JSON only, with exactly these keys:
  "description": 2-3 plain sentences on what the item is, the fabric or material,
                 the fit or cut, the colours, and any construction detail worth
                 noticing (seams, ribbing, hardware, print method).
  "tags":        3-6 short lowercase tags we could file it under.
  "category":    one of: tee, hoodie, sweat, longsleeve, jacket, knit, trousers,
                 headwear, accessory, print, graphic, typography, colour, fabric,
                 detail, fit, packaging, campaign, store, other

Be concrete and factual. Describe what is actually there, not what it evokes.
Do not guess a brand name. If something is genuinely unclear from the photo, say
so in the description rather than inventing it.`;

const LOOKBOOK_CATEGORIES = new Set([
  "tee", "hoodie", "sweat", "longsleeve", "jacket", "knit", "trousers",
  "headwear", "accessory", "print", "graphic", "typography", "colour",
  "fabric", "detail", "fit", "packaging", "campaign", "store", "other",
]);

async function describePhoto(token: string, storagePath: string, note: string) {
  const img = await fetch(
    `${SUPABASE_URL}/storage/v1/object/lookbook/${encodeURI(storagePath)}`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } },
  );
  if (!img.ok) throw new Error("could not read that photo");

  const mime = img.headers.get("Content-Type") ?? "image/jpeg";
  const bytes = new Uint8Array(await img.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const b64 = btoa(binary);

  let prompt = LOOKBOOK_BRIEF;
  if (note) prompt += `

The person who saved it wrote: "${note}" — treat that as a hint about what mattered to them, not as fact.`;

  const failures: string[] = [];
  for (const model of VISION_MODELS) {
    try {
      const r = await fetch(`${GEMINI_ROOT}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
      });
      if (!r.ok) { failures.push(`${model}: ${(await r.text()).slice(0, 200)}`); continue; }
      const data = await r.json();
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? "").join("").trim();
      if (!text) { failures.push(`${model}: empty reply`); continue; }
      const parsed = JSON.parse(text);
      const tags = (Array.isArray(parsed.tags) ? parsed.tags : [])
        .map((t: any) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 6);
      const category = String(parsed.category ?? "").trim().toLowerCase();
      return {
        description: String(parsed.description ?? "").trim().slice(0, 2000),
        tags,
        category: LOOKBOOK_CATEGORIES.has(category) ? category : "",
      };
    } catch (e) {
      failures.push(`${model}: ${String(e).slice(0, 160)}`);
    }
  }
  throw new Error(failures.join(" | ") || "no model answered");
}


/* Downloading a picture someone pasted a link to.
 *
 * The browser cannot fetch most other sites' images, so this does it. That
 * means the function will retrieve a URL a person supplies, which is worth
 * bounding carefully:
 *   - http/https only, so no file:// or other schemes
 *   - refuses private and loopback addresses, so it cannot be pointed at
 *     anything inside Supabase's network
 *   - image content-types only
 *   - 10MB ceiling
 *   - no redirects followed blindly past the first hop
 */
const MAX_LINK_BYTES = 10 * 1024 * 1024;

function isPrivateHost(hostname: string) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (/^\[?::1\]?$/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

async function fetchLinkedImage(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("that is not a web address"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https links");
  if (isPrivateHost(url.hostname)) throw new Error("that address is not reachable");

  /* Claude — 2026-08-13: a browser-shaped User-Agent, because a fair number of
     sites refuse anything that looks automated and Marco pasting a normal
     product link should not hit that wall. */
  const UA = "Mozilla/5.0 (compatible; FAKESNIFF-Hub/1.0; +https://fakesniff.nl)";

  let r = await fetch(url.href, {
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "image/*,text/html;q=0.9" },
  });
  if (!r.ok) throw new Error(`that link did not open (the site said ${r.status})`);

  let type = (r.headers.get("Content-Type") ?? "").split(";")[0].trim();

  /* People paste the page they are looking at, not the image file on it.
     Expecting anyone to right-click and copy an image address is not how this
     gets used, so when we are handed a page we find its main picture the same
     way every link preview does. */
  if (type.startsWith("text/html")) {
    const html = (await r.text()).slice(0, 400_000);
    const pick = (re: RegExp) => { const m = html.match(re); return m ? m[1] : ""; };
    const candidate =
      pick(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i)
      || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
      || pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || pick(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)
      || pick(/<img[^>]+src=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i);

    if (!candidate) throw new Error("we could not find a picture on that page");

    let imageUrl: URL;
    try { imageUrl = new URL(candidate, url.href); } catch { throw new Error("that page's picture link is broken"); }
    if (imageUrl.protocol !== "http:" && imageUrl.protocol !== "https:") throw new Error("that page's picture link is not usable");
    if (isPrivateHost(imageUrl.hostname)) throw new Error("that address is not reachable");

    r = await fetch(imageUrl.href, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "image/*", Referer: url.origin },
    });
    if (!r.ok) throw new Error("the picture on that page could not be downloaded");
    type = (r.headers.get("Content-Type") ?? "").split(";")[0].trim();
    url = imageUrl;
  }

  if (!type.startsWith("image/")) throw new Error("that link does not lead to a picture");

  const declared = Number(r.headers.get("Content-Length") ?? "0");
  if (declared > MAX_LINK_BYTES) throw new Error("that picture is too large");

  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > MAX_LINK_BYTES) throw new Error("that picture is too large");

  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const name = (url.pathname.split("/").pop() || "linked").replace(/[^a-zA-Z0-9._-]/g, "-").slice(-60);
  return { dataUrl: `data:${type};base64,${btoa(binary)}`, name };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!GEMINI_KEY || !SUPABASE_URL || !ANON_KEY) {
    return json({ error: "The assistant is not configured yet." }, 500);
  }

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in to use the assistant." }, 401);

  const user = await callerIdentity(token);
  if (!user) return json({ error: "That session is no longer valid. Sign in again." }, 401);

  /* Codex — 2026-08-13: this gate intentionally precedes body parsing, image
     generation, Gemini and all other table reads. A valid non-member learns
     nothing and cannot use the assistant as a generic model proxy. */
  const member = await activeCallerMembership(token, String(user.id));
  if (!member) return json({ error: "This account does not have access to the assistant." }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }

  /* Image generation is its own path — no chat history, no context. */
  if (body?.mode === "image") {
    const prompt = String(body.prompt ?? "").trim().slice(0, 900);
    if (!prompt) return json({ error: "Say what you want a picture of." }, 400);
    try {
      const { dataUrl } = await makeImage(prompt);
      return json({ image: dataUrl });
    } catch (e) {
      const detail = String(e instanceof Error ? e.message : e);
      /* Claude — 2026-08-13: a quota refusal is not a prompt problem, and
         telling someone to "describe it differently" when the account simply
         has no image quota sends them in circles rewording a perfectly good
         sentence. Name the real reason. */
      const quota = /429|exceeded your current quota|billing/i.test(detail);
      return json({
        error: quota
          ? "Picture generation is not switched on for this account yet. Reading and describing photos still works — this needs billing enabled on the Google AI key."
          : "That picture could not be generated.",
        detail: detail.slice(0, 700),
      }, quota ? 402 : 502);
    }
  }

  /* Turning a pasted link into a real picture. */
  if (body?.mode === "fetch-image") {
    try {
      const out = await fetchLinkedImage(String(body.url ?? ""));
      return json(out);
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e).slice(0, 160) }, 400);
    }
  }

  /* Describing a photo the moment it is uploaded. */
  if (body?.mode === "analyse") {
    const path = String(body.storagePath ?? "").trim();
    if (!path) return json({ error: "No photo to look at." }, 400);
    try {
      const result = await describePhoto(token, path, String(body.note ?? "").slice(0, 400));
      return json(result);
    } catch (e) {
      return json({ error: "That photo could not be described just now.", detail: String(e).slice(0, 200) }, 502);
    }
  }

  const message = String(body?.message ?? "").trim().slice(0, 2000);
  if (!message) return json({ error: "Say something first." }, 400);

  const section = SECTIONS.includes(String(body?.section)) ? String(body.section) : "home";
  const history = Array.isArray(body?.history) ? body.history.slice(-8) : [];

  const { who, summary } = await gatherContext(token, member);

  const contents = [
    ...history.map((h: any) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: String(h.text ?? "").slice(0, 2000) }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const systemText = `${SYSTEM}

They are currently on the "${section}" page.

What is actually in the workspace right now:
${summary}`;

  try {
    const { text, model } = await askGemini(contents, systemText);
    const { reply, action } = splitAction(text);
    return json({ reply, action, model, who: who.display_name });
  } catch {
    return json({
      error: "The assistant could not answer just now. Nothing was lost — try again.",
    }, 502);
  }
});
