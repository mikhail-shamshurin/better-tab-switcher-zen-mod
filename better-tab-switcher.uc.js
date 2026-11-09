// ==UserScript==
// @name           Better Tab Switcher
// @description    MRU tab switcher on Ctrl+Tab with page previews
// @include        main
// ==/UserScript==

(function () {
  "use strict";

  const LOG_PREFIX = "[better-tab-switcher]";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const INSTANCE_KEY = "__betterTabSwitcher";
  const BOOT_RETRY_MS = 200;

  const Direction = Object.freeze({ FORWARD: 1, BACKWARD: -1 });

  /** Unloads the instance left by a previous run of this script (reload, mod update). */
  function destroyPreviousInstance() {
    try {
      window[INSTANCE_KEY]?.destroy();
    } catch (error) {
      console.error(LOG_PREFIX, "failed to unload the previous instance", error);
    }
  }

  function whenWindowLoaded(callback) {
    if (document.readyState === "complete") callback();
    else window.addEventListener("load", callback, { once: true });
  }

  function startWhenBrowserReady() {
    if (!ZenWindow.isReady()) {
      setTimeout(startWhenBrowserReady, BOOT_RETRY_MS);
      return;
    }
    try {
      const mod = new BetterTabSwitcher(window, new ZenWindow(), new Settings(Services.prefs));
      mod.start();
      window[INSTANCE_KEY] = {
        destroy() {
          mod.stop();
          delete window[INSTANCE_KEY];
        },
      };
    } catch (error) {
      console.error(LOG_PREFIX, "init failed", error);
    }
  }

  /** The mod as a whole: connects the switcher to the window's keyboard and tab events. */
  class BetterTabSwitcher {
    #window;
    #browser;
    #history = new TabHistory();
    #previews;
    #switcher;
    #keyboard;
    #subscriptions = new EventSubscriptions();

    constructor(window, browser, settings) {
      this.#window = window;
      this.#browser = browser;
      this.#previews = new TabPreviews(window.document);
      this.#switcher = new TabSwitcher({
        document: window.document,
        browser,
        history: this.#history,
        previews: this.#previews,
        settings,
      });
      this.#keyboard = new KeyboardShortcuts(this.#switcher);
    }

    start() {
      this.#history.reset(this.#browser.tabs, this.#browser.selectedTab);
      this.#previews.captureSoon(this.#browser.selectedTab);
      this.#listenToWindow();
      this.#listenToTabs();
    }

    stop() {
      this.#subscriptions.removeAll();
      this.#switcher.dispose();
      this.#previews.cancelPendingCapture();
    }

    #listenToWindow() {
      const window = this.#window;
      this.#subscriptions.listen(window, "keydown", event => this.#keyboard.handleKeyDown(event), true);
      this.#subscriptions.listen(window, "keyup", event => this.#keyboard.handleKeyUp(event), true);
      this.#subscriptions.listen(window, "blur", () => this.#switcher.cancel());
      this.#subscriptions.listen(window, "resize", () => this.#switcher.resize());
    }

    #listenToTabs() {
      const tabs = this.#browser.tabContainer;
      this.#subscriptions.listen(tabs, "TabSelect", () => this.#handleTabSelect());
      this.#subscriptions.listen(tabs, "TabOpen", event => this.#history.addAsLeastRecent(event.target));
      this.#subscriptions.listen(tabs, "TabClose", event => this.#handleTabClose(event.target));
    }

    #handleTabSelect() {
      // The order stays fixed during a switch; the chosen tab is recorded on commit.
      if (this.#switcher.isActive) return;
      const tab = this.#browser.selectedTab;
      this.#history.markUsed(tab);
      this.#previews.captureSoon(tab);
    }

    #handleTabClose(tab) {
      this.#history.remove(tab);
      this.#switcher.handleTabClosed(tab);
    }
  }

  /** Turns key presses into switcher commands. Outside a switch only Ctrl+Tab is handled. */
  class KeyboardShortcuts {
    #switcher;
    #keysWhileSwitching;

    constructor(switcher) {
      this.#switcher = switcher;
      this.#keysWhileSwitching = new Map([
        ["Escape", () => switcher.cancel()],
        ["Enter", () => switcher.commit()],
        ["ArrowRight", () => switcher.move(Direction.FORWARD)],
        ["ArrowDown", () => switcher.move(Direction.FORWARD)],
        ["ArrowLeft", () => switcher.move(Direction.BACKWARD)],
        ["ArrowUp", () => switcher.move(Direction.BACKWARD)],
      ]);
    }

    handleKeyDown(event) {
      if (isCtrlTab(event)) {
        consume(event);
        this.#handleCtrlTab(event.shiftKey ? Direction.BACKWARD : Direction.FORWARD);
        return;
      }
      if (!this.#switcher.isActive) return;
      const command = this.#keysWhileSwitching.get(event.key);
      if (!command) return;
      consume(event);
      command();
    }

    handleKeyUp(event) {
      if (event.key === "Control") this.#switcher.commit();
    }

    #handleCtrlTab(direction) {
      if (this.#switcher.isActive) this.#switcher.move(direction);
      else this.#switcher.begin(direction);
    }
  }

  function isCtrlTab(event) {
    return event.key === "Tab" && event.ctrlKey && !event.altKey && !event.metaKey;
  }

  /** Keeps the event from Firefox's own Ctrl+Tab handler and from the page. */
  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /**
   * One Ctrl+Tab gesture: it begins on the first press, moves the selection on the next
   * ones and switches tabs on commit. The overlay appears only after a short delay, so a
   * quick tap jumps to the previous tab without flashing it.
   */
  class TabSwitcher {
    static #MIN_TABS = 2;

    #browser;
    #history;
    #previews;
    #settings;
    #overlay;
    /** @type {CardSelection | null} null while no switch is in progress */
    #selection = null;
    #overlayTimer = null;

    constructor({ document, browser, history, previews, settings }) {
      this.#browser = browser;
      this.#history = history;
      this.#previews = previews;
      this.#settings = settings;
      this.#overlay = new SwitcherOverlay(
        document,
        previews,
        index => this.pick(index),
        index => this.hover(index)
      );
    }

    get isActive() {
      return this.#selection !== null;
    }

    begin(direction) {
      const tabs = this.#collectTabs();
      if (tabs.length < TabSwitcher.#MIN_TABS) return;
      this.#selection = new CardSelection(tabs);
      this.#selection.move(direction);
      this.#previews.captureNow(this.#browser.selectedTab).then(() => this.#redrawOverlay());
      this.#showOverlayAfter(this.#settings.showDelayMs);
    }

    /** The user keeps cycling, so the cards are shown right away. */
    move(direction) {
      this.#selection.move(direction);
      this.#showOverlay();
    }

    /** Only the "selected" attribute moves: rebuilding the cards here would replace the one the mouse is over mid-click, dropping the click. */
    hover(index) {
      this.#selection.select(index);
      this.#overlay.highlight(index);
    }

    pick(index) {
      this.#selection.select(index);
      this.commit();
    }

    commit() {
      if (!this.isActive) return;
      const target = this.#selection.tab;
      this.#end();
      if (target.isConnected && target !== this.#browser.selectedTab) this.#browser.select(target);
      this.#history.markUsed(this.#browser.selectedTab);
    }

    cancel() {
      if (this.isActive) this.#end();
    }

    resize() {
      this.#overlay.resize();
    }

    handleTabClosed(tab) {
      if (!this.isActive) return;
      this.#selection.remove(tab);
      if (this.#selection.size < TabSwitcher.#MIN_TABS) this.cancel();
      else this.#redrawOverlay();
    }

    dispose() {
      this.cancel();
      this.#overlay.remove();
    }

    #collectTabs() {
      return collectSwitchableTabs({
        recentTabs: this.#history.mostRecentFirst(),
        currentTab: this.#browser.selectedTab,
        spaceId: this.#settings.showAllSpaces ? null : this.#browser.activeSpaceId,
        limit: this.#settings.maxCards,
      });
    }

    #showOverlayAfter(delayMs) {
      if (delayMs === 0) this.#showOverlay();
      else this.#overlayTimer = setTimeout(() => this.#showOverlay(), delayMs);
    }

    #showOverlay() {
      this.#cancelOverlayTimer();
      this.#overlay.render(this.#selection.tabs, this.#selection.index);
    }

    #redrawOverlay() {
      if (this.#overlay.isVisible) this.#showOverlay();
    }

    #end() {
      this.#cancelOverlayTimer();
      this.#selection = null;
      this.#overlay.hide();
    }

    #cancelOverlayTimer() {
      clearTimeout(this.#overlayTimer);
      this.#overlayTimer = null;
    }
  }

  /** The tabs offered by one switch and the selected one. Moving wraps around the ends. */
  class CardSelection {
    #tabs;
    #index = 0;

    constructor(tabs) {
      this.#tabs = tabs;
    }

    get tabs() {
      return this.#tabs;
    }

    get index() {
      return this.#index;
    }

    get tab() {
      return this.#tabs[this.#index];
    }

    get size() {
      return this.#tabs.length;
    }

    move(direction) {
      this.#index = (this.#index + direction + this.size) % this.size;
    }

    select(index) {
      this.#index = index;
    }

    remove(tab) {
      this.#tabs = this.#tabs.filter(other => other !== tab);
      this.#index = Math.min(this.#index, this.size - 1);
    }
  }

  /**
   * Tabs for one switch, most recently used first. The current tab always comes first,
   * so the selection starts from it. A null `spaceId` means tabs of every space.
   */
  function collectSwitchableTabs({ recentTabs, currentTab, spaceId, limit }) {
    const otherTabs = recentTabs.filter(
      tab => tab !== currentTab && isSwitchable(tab) && isInSpace(tab, spaceId)
    );
    return [currentTab, ...otherTabs].slice(0, limit);
  }

  function isSwitchable(tab) {
    return tab.isConnected && !tab.closing && !tab.hasAttribute("zen-empty-tab") && !isClosedPinned(tab);
  }

  /** Closing a pinned tab leaves it in the tab strip, unloaded until clicked again: not actually open. */
  function isClosedPinned(tab) {
    return tab.hasAttribute("pinned") && tab.hasAttribute("pending");
  }

  /** Essentials and tabs without a space are shown in every space. */
  function isInSpace(tab, spaceId) {
    if (!spaceId || tab.hasAttribute("zen-essential")) return true;
    const tabSpaceId = tab.getAttribute("zen-workspace-id");
    return !tabSpaceId || tabSpaceId === spaceId;
  }

  /** Tabs in the order of use (MRU): the most recently used tab is last. */
  class TabHistory {
    #tabs = [];

    reset(tabs, currentTab) {
      this.#tabs = [...tabs];
      this.markUsed(currentTab);
    }

    markUsed(tab) {
      if (!tab) return;
      this.remove(tab);
      this.#tabs.push(tab);
    }

    addAsLeastRecent(tab) {
      if (!this.#tabs.includes(tab)) this.#tabs.unshift(tab);
    }

    remove(tab) {
      this.#tabs = this.#tabs.filter(other => other !== tab);
    }

    mostRecentFirst() {
      return [...this.#tabs].reverse();
    }
  }

  /** Page snapshots for the cards. A tab is captured after it has been viewed for a moment. */
  class TabPreviews {
    static #CAPTURE_DELAY_MS = 600;
    /** About twice the card width, so previews stay sharp on HiDPI screens. */
    static #MAX_WIDTH_PX = 560;
    static #JPEG_QUALITY = 0.7;
    static #PAGE_BACKGROUND = "white";

    #document;
    /** @type {WeakMap<object, string>} tab -> JPEG data URL */
    #images = new WeakMap();
    #pendingCapture = null;

    constructor(document) {
      this.#document = document;
    }

    imageOf(tab) {
      return this.#images.get(tab);
    }

    /** Tabs the user only flicks through are never captured. */
    captureSoon(tab) {
      this.cancelPendingCapture();
      this.#pendingCapture = setTimeout(() => {
        this.#pendingCapture = null;
        this.#capture(tab);
      }, TabPreviews.#CAPTURE_DELAY_MS);
    }

    captureNow(tab) {
      this.cancelPendingCapture();
      return this.#capture(tab);
    }

    cancelPendingCapture() {
      clearTimeout(this.#pendingCapture);
      this.#pendingCapture = null;
    }

    async #capture(tab) {
      if (!tab?.isConnected || tab.hasAttribute("pending")) return;
      try {
        const image = await this.#snapshot(tab.linkedBrowser);
        if (image) this.#images.set(tab, image);
      } catch {
        // Discarded tabs and some internal pages cannot be captured: the card shows no preview.
      }
    }

    async #snapshot(browser) {
      const width = browser?.clientWidth;
      const height = browser?.clientHeight;
      const windowGlobal = browser?.browsingContext?.currentWindowGlobal;
      if (!windowGlobal || !width || !height) return null;

      const scale = Math.min(1, TabPreviews.#MAX_WIDTH_PX / width);
      const area = new DOMRect(0, 0, width, height);
      const bitmap = await windowGlobal.drawSnapshot(area, scale, TabPreviews.#PAGE_BACKGROUND);
      try {
        return this.#encodeJpeg(bitmap);
      } finally {
        bitmap.close?.();
      }
    }

    #encodeJpeg(bitmap) {
      const canvas = this.#document.createElementNS(XHTML_NS, "canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      return canvas.toDataURL("image/jpeg", TabPreviews.#JPEG_QUALITY);
    }
  }

  /** The full-window overlay with one card per tab. It draws what it is given, nothing more. */
  class SwitcherOverlay {
    static #ROOT_ID = "bts";
    static #FALLBACK_ICON = "chrome://global/skin/icons/defaultFavicon.svg";

    #document;
    #previews;
    #onPick;
    #onHover;
    #root = null;
    /** @type {HTMLElement[]} the cards shown by the last render(), in order */
    #cards = [];

    constructor(document, previews, onPick, onHover) {
      this.#document = document;
      this.#previews = previews;
      this.#onPick = onPick;
      this.#onHover = onHover;
    }

    get isVisible() {
      return this.#root?.getAttribute("open") === "true";
    }

    render(tabs, selectedIndex) {
      const root = this.#ensureRoot();
      root.replaceChildren(this.#createRow(tabs, selectedIndex));
      root.setAttribute("open", "true");
      this.#revealSelectedCard();
    }

    resize() {
      if (!this.isVisible) return;
      this.#revealSelectedCard();
    }

    /** Moves the "selected" card without touching the DOM nodes, so a click in flight survives. */
    highlight(index) {
      this.#cards.forEach((card, cardIndex) => {
        if (cardIndex === index) card.setAttribute("selected", "true");
        else card.removeAttribute("selected");
      });
      this.#revealSelectedCard();
    }

    #revealSelectedCard() {
      const selected = this.#cards.find(card => card.getAttribute("selected") === "true");
      selected?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }

    hide() {
      this.#root?.removeAttribute("open");
      this.#root?.replaceChildren();
      this.#cards = [];
    }

    remove() {
      this.#root?.remove();
      this.#root = null;
      this.#cards = [];
    }

    #ensureRoot() {
      this.#root ??= this.#createRoot();
      return this.#root;
    }

    #createRoot() {
      const root = this.#createElement("div");
      root.id = SwitcherOverlay.#ROOT_ID;
      // A click on a card must not move focus or start a text selection.
      root.addEventListener("mousedown", event => event.preventDefault());
      this.#document.documentElement.appendChild(root);
      return root;
    }

    #createRow(tabs, selectedIndex) {
      const row = this.#createElement("div", "bts-row");
      this.#cards = tabs.map((tab, index) => this.#createCard(tab, index, index === selectedIndex));
      row.append(...this.#cards);
      return row;
    }

    #createCard(tab, index, isSelected) {
      const card = this.#createElement("div", "bts-card");
      if (isSelected) card.setAttribute("selected", "true");
      card.append(this.#createPreview(tab), this.#createFooter(tab));
      // mousedown, not click: a click after this root's own preventDefault never reaches the card.
      card.addEventListener("mousedown", () => this.#onPick(index));
      // Rebuilt cards can enter a stationary pointer without mouse movement.
      card.addEventListener("mousemove", event => {
        if (event.movementX || event.movementY) this.#onHover(index);
      });
      return card;
    }

    #createPreview(tab) {
      const preview = this.#createElement("div", "bts-preview");
      const image = this.#previews.imageOf(tab);
      if (image) preview.appendChild(this.#createImage(image));
      return preview;
    }

    #createFooter(tab) {
      const footer = this.#createElement("div", "bts-footer");
      const icon = this.#createImage(tab.getAttribute("image") || SwitcherOverlay.#FALLBACK_ICON, "bts-icon");
      const title = this.#createElement("div", "bts-title");
      title.textContent = tab.label || "";
      footer.append(icon, title);
      return footer;
    }

    #createImage(src, className) {
      const image = this.#createElement("img", className);
      image.src = src;
      image.alt = "";
      return image;
    }

    #createElement(tagName, className) {
      const element = this.#document.createElementNS(XHTML_NS, tagName);
      if (className) element.className = className;
      return element;
    }
  }

  /** The settings from preferences.json, read on every use so that changes apply at once. */
  class Settings {
    static #PREFIX = "uc.bettertabswitcher.";

    #prefs;

    constructor(prefs) {
      this.#prefs = prefs;
    }

    get showAllSpaces() {
      return this.#readBool("all_spaces", false);
    }

    get showDelayMs() {
      return this.#readInt("show_delay", { fallback: 150, min: 0 });
    }

    get maxCards() {
      return this.#readInt("max_tabs", { fallback: 9, min: 2 });
    }

    #readBool(name, fallback) {
      const key = Settings.#PREFIX + name;
      const prefs = this.#prefs;
      return prefs.getPrefType(key) === prefs.PREF_BOOL ? prefs.getBoolPref(key) : fallback;
    }

    #readInt(name, { fallback, min }) {
      const value = this.#readNumber(Settings.#PREFIX + name);
      return Number.isInteger(value) && value >= min ? value : fallback;
    }

    /** preferences.json stores numbers as strings; integer prefs are accepted too. */
    #readNumber(key) {
      const prefs = this.#prefs;
      switch (prefs.getPrefType(key)) {
        case prefs.PREF_INT:
          return prefs.getIntPref(key);
        case prefs.PREF_STRING:
          return Number.parseInt(prefs.getStringPref(key), 10);
        default:
          return NaN;
      }
    }
  }

  /**
   * The only code that touches the browser globals gBrowser and gZenWorkspaces.
   * They are internal Zen APIs that change between versions, so they stay behind this class.
   */
  class ZenWindow {
    static isReady() {
      return typeof gBrowser !== "undefined" && Boolean(gBrowser.tabContainer);
    }

    get tabs() {
      return gBrowser.tabs;
    }

    get selectedTab() {
      return gBrowser.selectedTab;
    }

    get tabContainer() {
      return gBrowser.tabContainer;
    }

    /** null when spaces are unavailable, which turns off filtering by space. */
    get activeSpaceId() {
      try {
        return gZenWorkspaces.activeWorkspace;
      } catch {
        return null;
      }
    }

    select(tab) {
      try {
        gBrowser.selectedTab = tab;
      } catch (error) {
        console.error(LOG_PREFIX, "select failed", error);
      }
    }
  }

  /** Remembers every listener it adds, so that all of them can be removed in one call. */
  class EventSubscriptions {
    #removers = [];

    listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      this.#removers.push(() => target.removeEventListener(type, handler, options));
    }

    removeAll() {
      for (const remove of this.#removers.splice(0)) remove();
    }
  }

  destroyPreviousInstance();
  whenWindowLoaded(startWhenBrowserReady);
})();
