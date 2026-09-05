/* Codex — minimal DOM for daily-update behavior tests.
 * This models form input, event bubbling and disabled controls; it does not
 * claim to test layout, focus visibility or native browser validation. */
export class TestElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this._text = "";
  }

  set textContent(value) {
    this._text = String(value);
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join(" ");
  }

  append(...nodes) {
    nodes.forEach((node) => {
      node.parentElement = this;
      this.children.push(node);
    });
  }

  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.textContent = ""; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.ownerDocument.activeElement = this; }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      const match = part.trim().match(/^([\w-]+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\])?$/);
      if (!match) throw new Error(`Unsupported test selector: ${part}`);
      const [, tag, className, attr, value] = match;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (className && !this.className.split(/\s+/).includes(className)) return false;
      if (!attr) return true;
      const actual = this.getAttribute(attr) ?? this[attr];
      return value === undefined
        ? (typeof actual === "boolean" ? actual : actual !== undefined && actual !== null)
        : String(actual) === value;
    });
  }

  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }

  dispatch(type, options = {}) {
    const event = {
      type, target: this, defaultPrevented: false, bubbles: true,
      preventDefault() { this.defaultPrevented = true; },
      ...options,
    };
    for (let node = this; node; node = event.bubbles ? node.parentElement : null) {
      event.currentTarget = node;
      for (const callback of node.listeners.get(type) || []) callback(event);
    }
    return event;
  }

  isDisabled() {
    return this.disabled || this.hasAttribute("disabled") ||
      this.getAttribute("aria-disabled") === "true" ||
      Boolean(this.closest("fieldset[disabled]"));
  }

  click() {
    if (this.isDisabled()) return false;
    const event = this.dispatch("click");
    if (!event.defaultPrevented && this.tagName === "BUTTON" && this.type === "submit") {
      this.closest("form")?.dispatch("submit");
    }
    return true;
  }
}

export function createTestDocument() {
  const document = {
    createElement(tag) { return new TestElement(tag, document); },
    querySelector(selector) { return document.documentElement.querySelector(selector); },
    querySelectorAll(selector) { return document.documentElement.querySelectorAll(selector); },
  };
  document.documentElement = document.createElement("html");
  document.head = document.createElement("head");
  document.body = document.createElement("body");
  document.documentElement.append(document.head, document.body);
  return document;
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function response(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function settle() {
  // Two turns allow chained token, fetch, response parsing and render promises
  // to finish without real network latency or a wall-clock sleep.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
