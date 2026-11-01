"use strict";

// A minimal stand-in for the Zen main window: just enough of gBrowser, the DOM,
// prefs and timers to run better-tab-switcher.uc.js in Node and observe it from outside.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT_PATH = path.join(__dirname, "..", "..", "better-tab-switcher.uc.js");
const PREF_PREFIX = "uc.bettertabswitcher.";

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
    this.defaultPrevented = false;
    this.immediatePropagationStopped = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {}

  stopImmediatePropagation() {
    this.immediatePropagationStopped = true;
  }
}

class FakeEventTarget {
  #listeners = new Map();

  addEventListener(type, handler, options) {
    const listener = { handler, capture: isCapture(options), once: Boolean(options?.once) };
    const listeners = this.#listeners.get(type) ?? [];
    if (listeners.some(existing => sameListener(existing, listener))) return;
    this.#listeners.set(type, [...listeners, listener]);
  }

  removeEventListener(type, handler, options) {
    const removed = { handler, capture: isCapture(options) };
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(type, listeners.filter(existing => !sameListener(existing, removed)));
  }

  dispatchEvent(event) {
    for (const listener of this.#listeners.get(event.type) ?? []) {
      if (listener.once) this.removeEventListener(event.type, listener.handler, listener.capture);
      listener.handler.call(this, event);
      if (event.immediatePropagationStopped) break;
    }
    return !event.defaultPrevented;
  }

  listenerCount(type) {
    return (this.#listeners.get(type) ?? []).length;
  }
}

function isCapture(options) {
  return options === true || Boolean(options?.capture);
}

function sameListener(a, b) {
  return a.handler === b.handler && a.capture === b.capture;
}

class FakeElement extends FakeEventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName;
    this.id = "";
    this.className = "";
    this.textContent = "";
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    parent.children = parent.children.filter(child => child !== this);
    this.parentNode = null;
  }

  /** The mod picks a card on mousedown (a click never reaches it in the real chrome window). */
  click() {
    this.dispatchEvent(new FakeEvent("mousedown"));
  }

  hover() {
    this.dispatchEvent(new FakeEvent("mouseenter"));
  }

  findAll(predicate) {
    const found = [];
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      found.push(...child.findAll(predicate));
    }
    return found;
  }

  findByClass(className) {
    return this.findAll(element => element.className === className);
  }
}

class FakeCanvas extends FakeElement {
  constructor() {
    super("canvas");
    this.width = 0;
    this.height = 0;
  }

  getContext() {
    return { drawImage() {} };
  }

  toDataURL(type) {
    return `data:${type};${this.width}x${this.height}`;
  }
}

class FakeDocument {
  constructor() {
    this.readyState = "complete";
    this.documentElement = new FakeElement("html");
  }

  createElementNS(namespace, tagName) {
    return tagName === "canvas" ? new FakeCanvas() : new FakeElement(tagName);
  }

  findAllById(id) {
    return this.documentElement.findAll(element => element.id === id);
  }
}

class FakeWindow extends FakeEventTarget {
  constructor(document) {
    super();
    this.document = document;
  }
}

class FakeTab extends FakeElement {
  constructor(label, attributes = {}) {
    super("tab");
    this.label = label;
    this.isConnected = true;
    this.closing = false;
    this.linkedBrowser = null;
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
  }
}

class FakeTabBrowser {
  constructor() {
    this.tabs = [];
    this.tabContainer = new FakeEventTarget();
    this.selectionHistory = [];
    this._selectedTab = null;
  }

  get selectedTab() {
    return this._selectedTab;
  }

  set selectedTab(tab) {
    if (tab === this._selectedTab) return;
    this._selectedTab = tab;
    this.selectionHistory.push(tab);
    this.tabContainer.dispatchEvent(new FakeEvent("TabSelect", { target: tab }));
  }

  addExistingTab(tab) {
    this.tabs.push(tab);
    this._selectedTab ??= tab;
  }

  openTab(tab) {
    this.tabs.push(tab);
    this.tabContainer.dispatchEvent(new FakeEvent("TabOpen", { target: tab }));
  }

  closeTab(tab) {
    tab.closing = true;
    this.tabContainer.dispatchEvent(new FakeEvent("TabClose", { target: tab }));
    this.tabs = this.tabs.filter(other => other !== tab);
    tab.isConnected = false;
    if (this._selectedTab === tab) this.selectedTab = this.tabs[0];
  }
}

class FakePrefs {
  PREF_INVALID = 0;
  PREF_STRING = 32;
  PREF_INT = 64;
  PREF_BOOL = 128;

  #values = new Map();

  set(name, value) {
    this.#values.set(PREF_PREFIX + name, { type: this.#typeOf(value), value });
  }

  getPrefType(key) {
    return this.#values.get(key)?.type ?? this.PREF_INVALID;
  }

  getBoolPref(key) {
    return this.#read(key, this.PREF_BOOL);
  }

  getIntPref(key) {
    return this.#read(key, this.PREF_INT);
  }

  getStringPref(key) {
    return this.#read(key, this.PREF_STRING);
  }

  #read(key, type) {
    const pref = this.#values.get(key);
    if (pref?.type !== type) throw new Error(`NS_ERROR_UNEXPECTED: ${key}`);
    return pref.value;
  }

  #typeOf(value) {
    if (typeof value === "boolean") return this.PREF_BOOL;
    if (Number.isInteger(value)) return this.PREF_INT;
    return this.PREF_STRING;
  }
}

class FakeClock {
  #now = 0;
  #nextId = 1;
  #timers = new Map();

  setTimeout = (callback, delay = 0) => {
    const id = this.#nextId++;
    this.#timers.set(id, { callback, dueAt: this.#now + delay });
    return id;
  };

  clearTimeout = id => {
    this.#timers.delete(id);
  };

  advance(milliseconds) {
    const end = this.#now + milliseconds;
    for (let timer = this.#nextDue(end); timer; timer = this.#nextDue(end)) {
      this.#timers.delete(timer.id);
      this.#now = timer.dueAt;
      timer.callback();
    }
    this.#now = end;
  }

  #nextDue(end) {
    let next = null;
    for (const [id, timer] of this.#timers) {
      if (timer.dueAt <= end && (!next || timer.dueAt < next.dueAt)) next = { id, ...timer };
    }
    return next;
  }
}

class FakeDOMRect {
  constructor(x, y, width, height) {
    Object.assign(this, { x, y, width, height });
  }
}

/** A browser whose page can be snapshotted for previews. */
function renderedPage({ width = 1200, height = 800, failSnapshot = false } = {}) {
  return {
    clientWidth: width,
    clientHeight: height,
    browsingContext: {
      currentWindowGlobal: {
        async drawSnapshot(rect, scale) {
          if (failSnapshot) throw new Error("snapshot unavailable");
          return { width: rect.width * scale, height: rect.height * scale, close() {} };
        },
      },
    },
  };
}

/**
 * Test driver: a Zen window with the given tabs, plus helpers that act like the user
 * (keys, clicks, waiting) and read what the user sees (selected tab, overlay cards).
 */
class ZenWindowDriver {
  constructor({ tabs = ["A", "B", "C"], activeSpace = null, documentReady = true, browserReady = true } = {}) {
    this.clock = new FakeClock();
    this.prefs = new FakePrefs();
    this.document = new FakeDocument();
    this.document.readyState = documentReady ? "complete" : "loading";
    this.window = new FakeWindow(this.document);
    this.gBrowser = new FakeTabBrowser();
    for (const tab of tabs) this.gBrowser.addExistingTab(toTab(tab));
    this.consoleErrors = [];
    this.context = vm.createContext({
      window: this.window,
      document: this.document,
      Services: { prefs: this.prefs },
      gZenWorkspaces: { activeWorkspace: activeSpace },
      console: { error: (...args) => this.consoleErrors.push(args), log() {}, warn() {} },
      setTimeout: this.clock.setTimeout,
      clearTimeout: this.clock.clearTimeout,
      DOMRect: FakeDOMRect,
    });
    if (browserReady) this.makeBrowserReady();
  }

  makeBrowserReady() {
    this.context.gBrowser = this.gBrowser;
  }

  loadScript() {
    vm.runInContext(fs.readFileSync(SCRIPT_PATH, "utf8"), this.context, { filename: SCRIPT_PATH });
    return this;
  }

  setPref(name, value) {
    this.prefs.set(name, value);
  }

  tab(label) {
    const tab = this.gBrowser.tabs.find(candidate => candidate.label === label);
    if (!tab) throw new Error(`no tab "${label}"`);
    return tab;
  }

  get selectedLabel() {
    return this.gBrowser.selectedTab?.label;
  }

  visit(...labels) {
    for (const label of labels) this.gBrowser.selectedTab = this.tab(label);
  }

  openTab(tab) {
    const opened = toTab(tab);
    this.gBrowser.openTab(opened);
    return opened;
  }

  closeTab(label) {
    this.gBrowser.closeTab(this.tab(label));
  }

  wait(milliseconds) {
    this.clock.advance(milliseconds);
  }

  async waitForPreviews(milliseconds = 0) {
    this.clock.advance(milliseconds);
    await new Promise(resolve => setImmediate(resolve));
  }

  holdCtrl() {
    return this.#key("keydown", "Control", { ctrlKey: true });
  }

  pressTab({ shift = false, ctrl = true, alt = false, meta = false } = {}) {
    const modifiers = { ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta };
    const down = this.#key("keydown", "Tab", modifiers);
    this.#key("keyup", "Tab", modifiers);
    return down;
  }

  releaseCtrl() {
    return this.#key("keyup", "Control");
  }

  press(key, modifiers = { ctrlKey: true }) {
    const down = this.#key("keydown", key, modifiers);
    this.#key("keyup", key, modifiers);
    return down;
  }

  /** Quick Ctrl+Tab tap: press and release before the overlay appears. */
  tapCtrlTab({ shift = false } = {}) {
    this.holdCtrl();
    this.pressTab({ shift });
    this.releaseCtrl();
  }

  blurWindow() {
    this.window.dispatchEvent(new FakeEvent("blur"));
  }

  finishDocumentLoad() {
    this.document.readyState = "complete";
    this.window.dispatchEvent(new FakeEvent("load"));
  }

  get overlay() {
    const [root] = this.document.findAllById("bts");
    const cards = root ? root.findByClass("bts-card") : [];
    return {
      isOpen: root?.getAttribute("open") === "true",
      count: this.document.findAllById("bts").length,
      titles: cards.map(card => card.findByClass("bts-title")[0].textContent),
      selectedTitle: cards
        .filter(card => card.getAttribute("selected") === "true")
        .map(card => card.findByClass("bts-title")[0].textContent)[0],
      previews: cards.map(card => card.findByClass("bts-preview")[0].children[0]?.src ?? null),
      icons: cards.map(card => card.findByClass("bts-icon")[0].src),
      cards,
      root,
    };
  }

  #key(type, key, modifiers = {}) {
    const event = new FakeEvent(type, { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers });
    this.window.dispatchEvent(event);
    return event;
  }
}

function toTab(tab) {
  if (tab instanceof FakeTab) return tab;
  if (typeof tab === "string") return new FakeTab(tab);
  const created = new FakeTab(tab.label, tab.attributes);
  created.linkedBrowser = tab.page ?? null;
  return created;
}

module.exports = { ZenWindowDriver, FakeTab, renderedPage };
