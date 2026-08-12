#!/usr/bin/env python3
"""
Describe Lookbook photos automatically.

Finds items that have an image but no description yet, sends each to Gemini,
and writes back a plain description plus a few tags so the photo becomes
searchable by what is actually in it.

Runs in GitHub Actions on a schedule. The API key never reaches the browser —
a key in frontend code is readable by anyone who opens the page.

Environment:
  GEMINI_API_KEY          required — from aistudio.google.com
  SUPABASE_URL            required — the project URL
  SUPABASE_SERVICE_KEY    required — service_role key. Bypasses row-level
                          security, which this job needs because it acts as
                          nobody. Server-side only, never in a client.
  SUPABASE_WORKSPACE_ID   optional — scope to one workspace
  GEMINI_MODEL            optional — defaults to a Flash model, see below
  MAX_ITEMS               optional — per-run cap (default 40)
"""
import base64, json, os, sys, time, urllib.error, urllib.parse, urllib.request

GEMINI_KEY   = os.environ.get("GEMINI_API_KEY", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_KEY", "")
WORKSPACE_ID = os.environ.get("SUPABASE_WORKSPACE_ID", "")
MAX_ITEMS    = int(os.environ.get("MAX_ITEMS", "40"))
BUCKET       = "lookbook"

# Model names move; this is a preference order, and we fall back to whatever the
# account actually exposes rather than failing on a stale name.
PREFERRED_MODELS = [
    os.environ.get("GEMINI_MODEL", ""),
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-flash-latest",
]
GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta"

PROMPT = """Look at this clothing or material reference and describe it for a small streetwear brand's design library.

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
so in the description rather than inventing it."""

VALID_CATEGORIES = {
    "tee", "hoodie", "sweat", "longsleeve", "jacket", "knit", "trousers",
    "headwear", "accessory", "print", "graphic", "typography", "colour",
    "fabric", "detail", "fit", "packaging", "campaign", "store", "other",
}

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def check_config():
    missing = [n for n, v in (
        ("GEMINI_API_KEY", GEMINI_KEY),
        ("SUPABASE_URL", SUPABASE_URL),
        ("SUPABASE_SERVICE_KEY", SERVICE_KEY),
    ) if not v]
    if missing:
        die("missing environment variables: " + ", ".join(missing))


def sb(path, method="GET", body=None, extra_headers=None):
    headers = {
        "apikey": SERVICE_KEY,
        "Authorization": "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(SUPABASE_URL + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def fetch_pending():
    """Items with a photo we have not described yet."""
    q = ("/rest/v1/lookbook_items?select=id,title,note,storage_path,category"
         "&storage_path=not.is.null&ai_analysed_at=is.null&archived_at=is.null"
         f"&order=created_at.asc&limit={MAX_ITEMS}")
    if WORKSPACE_ID:
        q += f"&workspace_id=eq.{WORKSPACE_ID}"
    return sb(q) or []


def download_image(path):
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{urllib.parse.quote(path)}"
    req = urllib.request.Request(url, headers={
        "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read(), r.headers.get("Content-Type", "image/jpeg")


def resolve_model():
    """Pick a model that this key can actually use, rather than trusting a
    hardcoded name that may have been renamed."""
    try:
        req = urllib.request.Request(f"{GEMINI_ROOT}/models?key={GEMINI_KEY}")
        with urllib.request.urlopen(req, timeout=30) as r:
            available = json.load(r).get("models", [])
    except Exception as e:
        print(f"  could not list models ({str(e)[:60]}), trying preferences blind")
        return next((m for m in PREFERRED_MODELS if m), "gemini-2.0-flash")

    names = [m.get("name", "").split("/")[-1] for m in available
             if "generateContent" in (m.get("supportedGenerationMethods") or [])]
    for want in PREFERRED_MODELS:
        if want and want in names:
            return want
    # any flash-family model is the right cost tier for tagging photos
    flash = [n for n in names if "flash" in n and "thinking" not in n]
    if flash:
        return sorted(flash)[-1]
    if names:
        return names[0]
    die("this API key exposes no models that support generateContent")


def analyse(model, image_bytes, mime, note):
    prompt = PROMPT
    if note:
        prompt += f"\n\nThe person who saved it wrote: \"{note}\" — take that as a hint about what mattered to them, not as fact."
    body = {
        "contents": [{"parts": [
            {"text": prompt},
            {"inline_data": {"mime_type": mime, "data": base64.b64encode(image_bytes).decode()}},
        ]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2},
    }
    req = urllib.request.Request(
        f"{GEMINI_ROOT}/models/{model}:generateContent?key={GEMINI_KEY}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        payload = json.load(r)

    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("no candidates returned (possibly blocked by a safety filter)")
    parts = candidates[0].get("content", {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise RuntimeError("empty response")
    return json.loads(text)


def write_back(item_id, result, current_category):
    description = str(result.get("description", "")).strip()[:2000]
    tags = [str(t).strip().lower()[:40] for t in (result.get("tags") or []) if str(t).strip()][:6]
    category = str(result.get("category", "")).strip().lower()

    patch = {
        "ai_analysis": {"description": description, "tags": tags, "source": "gemini"},
        "ai_analysed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if tags:
        patch["tags"] = tags
    # File it only when the model returned a category we use AND the person
    # left it unsorted. A category someone chose deliberately is never
    # overwritten by the machine.
    if category in VALID_CATEGORIES and current_category in ("unsorted", "", None):
        patch["category"] = category

    path = f"/rest/v1/lookbook_items?id=eq.{item_id}"
    if WORKSPACE_ID:
        path += f"&workspace_id=eq.{WORKSPACE_ID}"
    sb(path, method="PATCH", body=patch, extra_headers={"Prefer": "return=minimal"})


def main():
    check_config()
    pending = fetch_pending()
    if not pending:
        print("nothing to describe")
        return

    model = resolve_model()
    print(f"describing {len(pending)} item(s) with {model}\n")

    done = failed = 0
    for item in pending:
        label = (item.get("title") or item.get("note") or item["storage_path"]).strip()[:52]
        try:
            image, mime = download_image(item["storage_path"])
            result = analyse(model, image, mime, item.get("note", ""))
            write_back(item["id"], result, item.get("category"))
            tags = ", ".join(result.get("tags", [])[:4])
            print(f"  ok   {label}\n       {tags}")
            done += 1
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode()[:180]
            except Exception:
                pass
            print(f"  fail {label}: HTTP {e.code} {detail}", file=sys.stderr)
            failed += 1
        except Exception as e:
            print(f"  fail {label}: {str(e)[:180]}", file=sys.stderr)
            failed += 1
        time.sleep(1)   # be polite to the free tier

    print(f"\ndescribed {done}, failed {failed}")
    if failed and not done:
        raise SystemExit(1)   # a wholly failed run should show red in Actions


if __name__ == "__main__":
    main()
