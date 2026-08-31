/* FAKESNIFF — the house brief. Owner: Claude.
 *
 * One place that knows what a FAKESNIFF garment looks like, so nobody using
 * the Hub has to describe it.
 *
 * The point Salman made and he is right: Marco and Emiel should type what goes
 * ON the shirt. Fabric weight, cut, print method, lighting, background — all of
 * that is the brand, it does not change per idea, and asking a non-designer to
 * respecify it every time is how you get twelve different-looking mockups of
 * the same product.
 *
 * So the person supplies the graphic. This supplies everything else.
 *
 * Shared by Designs and the Idea Lab on purpose. Two prompt builders would
 * drift within a week and the two screens would stop agreeing about what the
 * brand looks like.
 */

/* Written from what the brand actually is: black, cream, a bright green used
   sparingly, heavy blanks, and a slogan — "nothing is real" — that reads as
   deadpan rather than loud. The photography note matters as much as the
   garment note; it is the difference between a product photo and a render. */
const HOUSE = [
  "FAKESNIFF is a small Dutch streetwear label. Heavy cotton blanks, boxy",
  "modern cuts, nothing slim. The palette is black, washed black, cream and",
  "bone, with olive and heather grey as supporting colours. Prints are screen",
  "printed and sit slightly into the fabric rather than on top of it — matte,",
  "with a little texture, never glossy or vector-clean.",
  "Photograph it the way the brand shoots its own products: honest and",
  "unstyled, plain concrete or plain wall, soft daylight, real shadows,",
  "visible weave and natural creases. No props, no models posing, no text",
  "overlay, no watermark, no brand logo other than the graphic described.",
].join(" ");

/* Claude — 2026-08-30: each entry is [value, label key, prompt text].
 *
 * The middle one is translated because a person reads it. The third is NOT and
 * must never be: it goes to the image model, the whole house brief around it is
 * English, and a prompt written half in Dutch produces a worse picture. What
 * Marco sees changes with his language; what the model is asked for does not. */
export const GARMENTS = [
  ["hoodie", "designs.garment_hoodie", "a heavyweight oversized pullover hoodie"],
  ["tee", "designs.garment_tee", "a boxy heavyweight cotton t-shirt"],
  ["longsleeve", "designs.garment_longsleeve", "a boxy long-sleeve cotton top"],
  ["sweat", "designs.garment_sweat", "a heavyweight crewneck sweatshirt"],
  ["jacket", "designs.garment_jacket", "a workwear-cut cotton jacket"],
  ["cap", "designs.garment_cap", "a six-panel cap"],
  ["beanie", "designs.garment_beanie", "a ribbed knit beanie"],
  ["trousers", "designs.garment_trousers", "a pair of relaxed-fit cotton trousers"],
  ["tote", "designs.garment_tote", "a heavy cotton tote bag"],
];

export const COLOURS = [
  ["black", "designs.colour_black"], ["washed-black", "designs.colour_washed_black"], ["cream", "designs.colour_cream"],
  ["bone", "designs.colour_bone"], ["grey", "designs.colour_grey"], ["olive", "designs.colour_olive"],
  ["navy", "designs.colour_navy"], ["brown", "designs.colour_brown"],
];

export const SHOTS = [
  ["flat", "designs.shot_flat", "laid flat and photographed from directly above on plain concrete"],
  ["hanger", "designs.shot_hanger", "hanging on a plain metal rail against a plain wall"],
  ["worn", "designs.shot_worn", "worn by a person photographed from the chest up, plain background, their face not the subject"],
  ["detail", "designs.shot_detail", "a close macro photograph of the print and the fabric texture"],
];

/* The English words the model is asked for, kept apart from the labels a person
   reads so translating the interface cannot change the picture we generate. */
const COLOUR_WORDS = {
  "black": "black", "washed-black": "washed black", "cream": "cream",
  "bone": "bone", "grey": "heather grey", "olive": "olive",
  "navy": "navy", "brown": "brown",
};

const find = (list, v, fallbackIndex = 0) => list.find(([key]) => key === v) || list[fallbackIndex];

/**
 * Build the brief. `graphic` is the only thing a person writes.
 *
 * `reference` is optional: a short line describing real material we already
 * hold — a fabric or garment from the Lookbook — so the model is anchored to
 * something the brand actually owns rather than a generic idea of streetwear.
 */
export function buildGarmentPrompt({ graphic, garment, colour, shot, reference = "" } = {}) {
  const g = find(GARMENTS, garment);
  const c = find(COLOURS, colour);
  const s = find(SHOTS, shot);

  const parts = [
    `A realistic product photograph of ${g[2]} in ${COLOUR_WORDS[c[0]]}.`,
    `The graphic on it: ${String(graphic || "").trim() || "no graphic, a plain blank"}.`,
    `It is ${s[2]}.`,
    HOUSE,
  ];
  if (reference) {
    parts.push(`Match the material and finish of this reference from our own archive: ${reference}`);
  }
  return parts.join(" ");
}

/* An idea in the Idea Lab is a line and a concept, not a design brief. This
   turns one into something worth looking at without the person doing anything.
   Kept here rather than in the Idea Lab so both screens stay in step. */
export function promptFromIdea(idea, reference = "") {
  const line = String(idea?.line || "").trim();
  const concept = String(idea?.concept || "").trim();
  const graphic = concept
    ? `the words "${line}" set as the print, in the spirit of: ${concept}`
    : `the words "${line}" set as the print`;
  return buildGarmentPrompt({
    graphic,
    garment: "tee",
    colour: "black",
    shot: "flat",
    reference,
  });
}

/* A one-line reference drawn from what the Lookbook has actually described, so
   generation is anchored to real material rather than a stock idea of a hoodie.
   Returns "" when there is nothing described yet, which is the correct answer
   early on — a made-up reference would be worse than none. */
export function referenceFromLookbook(items = []) {
  const described = items
    .map((i) => i?.ai_analysis?.description)
    .filter((d) => typeof d === "string" && d.length > 40);
  if (!described.length) return "";
  return described[0].split(/(?<=\.)\s/).slice(0, 2).join(" ").slice(0, 400);
}
