// ==UserScript==
// @name           Better Tab Switcher
// @description    MRU tab switcher on Ctrl+Tab with page previews
// @include        main
// ==/UserScript==

(function () {
  "use strict";

  const LOG = "[better-tab-switcher]";
  const NS = "http://www.w3.org/1999/xhtml";
  const PREF = "uc.bettertabswitcher.";
  const FALLBACK_ICON = "chrome://global/skin/icons/defaultFavicon.svg";

  if (window.__betterTabSwitcher) {
    try {
      window.__betterTabSwitcher.destroy();
    } catch (e) {
      console.error(LOG, e);
    }
  }

  // ---------- prefs ----------
  function getBool(name, def) {
    try {
      if (Services.prefs.getPrefType(PREF + name) === Services.prefs.PREF_BOOL) {
        return Services.prefs.getBoolPref(PREF + name);
      }
    } catch (e) {}
    return def;
  }
  function getInt(name, def, min) {
    try {
      const t = Services.prefs.getPrefType(PREF + name);
      let v = NaN;
      if (t === Services.prefs.PREF_STRING) {
        v = parseInt(Services.prefs.getStringPref(PREF + name), 10);
      } else if (t === Services.prefs.PREF_INT) {
        v = Services.prefs.getIntPref(PREF + name);
      }
      if (Number.isFinite(v) && v >= min) return v;
    } catch (e) {}
    return def;
  }

  // ---------- MRU ----------
  /** @type {MozTabbrowserTab[]} most recent last */
  let mru = [];

  function touch(tab) {
    if (!tab) return;
    mru = mru.filter(t => t !== tab);
    mru.push(tab);
  }
  function seed() {
    mru = [];
    for (const t of gBrowser.tabs) mru.push(t);
    touch(gBrowser.selectedTab);
  }
  function onTabSelect() {
    // Leave the MRU alone while switching: the order is fixed on commit.
    if (state.active) return;
    touch(gBrowser.selectedTab);
    scheduleCapture();
  }
  function onTabClose(e) {
    mru = mru.filter(t => t !== e.target);
    if (state.active) {
      state.list = state.list.filter(t => t !== e.target);
      if (state.list.length < 2) cancel();
      else {
        state.index = Math.min(state.index, state.list.length - 1);
        render();
      }
    }
  }
  function onTabOpen(e) {
    if (!mru.includes(e.target)) mru.unshift(e.target);
  }

  function currentSpaceId() {
    try {
      return gZenWorkspaces.activeWorkspace;
    } catch (e) {
      return null;
    }
  }

  function buildList() {
    const allSpaces = getBool("all_spaces", false);
    const space = currentSpaceId();
    const max = getInt("max_tabs", 9, 2);
    const sel = gBrowser.selectedTab;
    const out = [];
    for (let i = mru.length - 1; i >= 0; i--) {
      const t = mru[i];
      if (!t.isConnected || t.closing) continue;
      if (t.hasAttribute("zen-empty-tab")) continue;
      if (!allSpaces && space && !t.hasAttribute("zen-essential")) {
        const ws = t.getAttribute("zen-workspace-id");
        if (ws && ws !== space) continue;
      }
      out.push(t);
    }
    // The current tab must come first.
    const si = out.indexOf(sel);
    if (si > 0) {
      out.splice(si, 1);
      out.unshift(sel);
    } else if (si < 0) {
      out.unshift(sel);
    }
    return out.slice(0, max);
  }

  // ---------- state / UI ----------
  const state = {
    active: false,
    shown: false,
    list: [],
    index: 0,
    timer: null,
    root: null,
  };

  // ---------- page previews ----------
  const THUMB_W = 280;
  /** @type {WeakMap<object, string>} tab -> snapshot dataURL */
  const thumbs = new WeakMap();
  let captureTimer = null;

  async function capture(tab) {
    try {
      if (!tab || !tab.isConnected || tab.hasAttribute("pending")) return;
      const browser = tab.linkedBrowser;
      const w = browser?.clientWidth;
      const h = browser?.clientHeight;
      const wg = browser?.browsingContext?.currentWindowGlobal;
      if (!wg || !w || !h) return;
      const scale = Math.min(1, (THUMB_W * 2) / w);
      const bmp = await wg.drawSnapshot(new DOMRect(0, 0, w, h), scale, "white");
      const canvas = document.createElementNS(NS, "canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close?.();
      thumbs.set(tab, canvas.toDataURL("image/jpeg", 0.7));
    } catch (e) {
      // Snapshot unavailable (discarded tab, internal page): the card shows no preview.
    }
  }

  function scheduleCapture() {
    if (captureTimer) clearTimeout(captureTimer);
    const tab = gBrowser.selectedTab;
    captureTimer = setTimeout(() => {
      captureTimer = null;
      if (!state.active) capture(tab);
    }, 600);
  }

  function iconFor(tab) {
    return tab.getAttribute("image") || FALLBACK_ICON;
  }

  function ensureRoot() {
    if (state.root) return state.root;
    const root = document.createElementNS(NS, "div");
    root.id = "bts";
    root.addEventListener("mousedown", e => e.preventDefault());
    document.documentElement.appendChild(root);
    state.root = root;
    return root;
  }

  function render() {
    if (!state.shown) return;
    const root = ensureRoot();
    root.replaceChildren();
    const row = document.createElementNS(NS, "div");
    row.className = "bts-row";
    state.list.forEach((tab, i) => {
      const card = document.createElementNS(NS, "div");
      card.className = "bts-card";
      if (i === state.index) card.setAttribute("selected", "true");
      const preview = document.createElementNS(NS, "div");
      preview.className = "bts-preview";
      const shot = thumbs.get(tab);
      if (shot) {
        const pimg = document.createElementNS(NS, "img");
        pimg.src = shot;
        pimg.alt = "";
        preview.appendChild(pimg);
      }
      const footer = document.createElementNS(NS, "div");
      footer.className = "bts-footer";
      const img = document.createElementNS(NS, "img");
      img.className = "bts-icon";
      img.src = iconFor(tab);
      img.alt = "";
      const title = document.createElementNS(NS, "div");
      title.className = "bts-title";
      title.textContent = tab.label || "";
      footer.append(img, title);
      card.append(preview, footer);
      card.addEventListener("click", () => {
        state.index = i;
        commit();
      });
      row.appendChild(card);
    });
    root.appendChild(row);
    root.setAttribute("open", "true");
  }

  function show() {
    state.timer = null;
    if (!state.active) return;
    state.shown = true;
    render();
  }

  function hide() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.shown = false;
    if (state.root) {
      state.root.removeAttribute("open");
      state.root.replaceChildren();
    }
  }

  function start(backwards) {
    state.list = buildList();
    if (state.list.length < 2) return false;
    state.active = true;
    capture(state.list[0]).then(() => {
      if (state.shown) render();
    });
    state.index = backwards ? state.list.length - 1 : 1;
    const delay = getInt("show_delay", 150, 0);
    if (delay === 0) show();
    else state.timer = setTimeout(show, delay);
    return true;
  }

  function step(backwards) {
    const n = state.list.length;
    state.index = (state.index + (backwards ? -1 : 1) + n) % n;
    // The user keeps cycling: show the overlay right away.
    if (!state.shown) {
      if (state.timer) clearTimeout(state.timer);
      show();
    } else {
      render();
    }
  }

  function commit() {
    if (!state.active) return;
    const target = state.list[state.index];
    state.active = false;
    hide();
    if (target && target.isConnected && target !== gBrowser.selectedTab) {
      try {
        gBrowser.selectedTab = target;
      } catch (e) {
        console.error(LOG, "select failed", e);
      }
    }
    touch(gBrowser.selectedTab);
  }

  function cancel() {
    if (!state.active) return;
    state.active = false;
    hide();
  }

  // ---------- keyboard ----------
  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onKeyDown(e) {
    if (e.key === "Tab" && e.ctrlKey && !e.altKey && !e.metaKey) {
      swallow(e);
      if (!state.active) {
        if (!start(e.shiftKey)) return;
      } else {
        step(e.shiftKey);
      }
      return;
    }
    if (!state.active) return;
    if (e.key === "Escape") {
      swallow(e);
      cancel();
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      swallow(e);
      step(false);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      swallow(e);
      step(true);
    } else if (e.key === "Enter") {
      swallow(e);
      commit();
    }
  }

  function onKeyUp(e) {
    if (state.active && e.key === "Control") commit();
  }

  function onBlur() {
    cancel();
  }

  // ---------- lifecycle ----------
  function init() {
    seed();
    scheduleCapture();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
    gBrowser.tabContainer.addEventListener("TabClose", onTabClose);
    gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen);
  }

  function destroy() {
    cancel();
    if (captureTimer) clearTimeout(captureTimer);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
    try {
      gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
      gBrowser.tabContainer.removeEventListener("TabClose", onTabClose);
      gBrowser.tabContainer.removeEventListener("TabOpen", onTabOpen);
    } catch (e) {}
    state.root?.remove();
    state.root = null;
    delete window.__betterTabSwitcher;
  }

  function boot() {
    if (typeof gBrowser === "undefined" || !gBrowser.tabContainer) {
      setTimeout(boot, 200);
      return;
    }
    try {
      init();
      window.__betterTabSwitcher = { destroy };
    } catch (e) {
      console.error(LOG, "init failed", e);
    }
  }

  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot, { once: true });
})();
