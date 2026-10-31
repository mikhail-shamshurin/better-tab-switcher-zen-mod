"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ZenWindowDriver, renderedPage } = require("./support/fake-browser");

const SHOW_DELAY_MS = 150;
const PREVIEW_CAPTURE_DELAY_MS = 600;
const BOOT_RETRY_MS = 200;

/** Zen window with tabs A, B, C visited in that order: C is current, B is the previous one. */
function zenWithRecentTabs(options) {
  const zen = new ZenWindowDriver(options).loadScript();
  zen.visit("A", "B", "C");
  return zen;
}

/** Holds Ctrl, presses Tab `times` times and waits until the overlay is visible. */
function openSwitcher(zen, { times = 1 } = {}) {
  zen.holdCtrl();
  for (let i = 0; i < times; i++) zen.pressTab();
  zen.wait(SHOW_DELAY_MS);
}

describe("quick Ctrl+Tab tap", () => {
  it("jumps to the previously used tab without showing the overlay", () => {
    const zen = zenWithRecentTabs();

    zen.tapCtrlTab();

    assert.equal(zen.selectedLabel, "B");
    assert.equal(zen.overlay.isOpen, false);
    assert.deepEqual(zen.overlay.titles, []);
  });

  it("toggles between the two most recent tabs", () => {
    const zen = zenWithRecentTabs();

    zen.tapCtrlTab();
    zen.tapCtrlTab();

    assert.equal(zen.selectedLabel, "C");
  });

  it("goes to the least recently used tab with Shift", () => {
    const zen = zenWithRecentTabs();

    zen.tapCtrlTab({ shift: true });

    assert.equal(zen.selectedLabel, "A");
  });

  it("consumes the key so Firefox's own Ctrl+Tab does not run", () => {
    const zen = zenWithRecentTabs();

    zen.holdCtrl();
    const event = zen.pressTab();

    assert.equal(event.defaultPrevented, true);
    assert.equal(event.immediatePropagationStopped, true);
  });
});

describe("holding Ctrl", () => {
  it("shows the overlay after the show delay, most recent tabs first", () => {
    const zen = zenWithRecentTabs();

    zen.holdCtrl();
    zen.pressTab();
    zen.wait(SHOW_DELAY_MS - 1);
    assert.equal(zen.overlay.isOpen, false);

    zen.wait(1);
    assert.equal(zen.overlay.isOpen, true);
    assert.deepEqual(zen.overlay.titles, ["C", "B", "A"]);
    assert.equal(zen.overlay.selectedTitle, "B");
  });

  it("opens the overlay at once when Tab is pressed again", () => {
    const zen = zenWithRecentTabs();

    zen.holdCtrl();
    zen.pressTab();
    zen.pressTab();

    assert.equal(zen.overlay.isOpen, true);
    assert.equal(zen.overlay.selectedTitle, "A");
  });

  it("wraps the selection around in both directions", () => {
    const zen = zenWithRecentTabs();

    openSwitcher(zen, { times: 3 });
    assert.equal(zen.overlay.selectedTitle, "C");

    zen.pressTab({ shift: true });
    assert.equal(zen.overlay.selectedTitle, "A");
  });

  it("switches to the selected tab when Ctrl is released", () => {
    const zen = zenWithRecentTabs();

    openSwitcher(zen, { times: 2 });
    zen.releaseCtrl();

    assert.equal(zen.selectedLabel, "A");
    assert.equal(zen.overlay.isOpen, false);
    assert.deepEqual(zen.overlay.titles, []);
  });

  it("moves the selection with the arrow keys and switches on Enter", () => {
    const zen = zenWithRecentTabs();
    openSwitcher(zen);

    zen.press("ArrowRight");
    assert.equal(zen.overlay.selectedTitle, "A");
    zen.press("ArrowDown");
    assert.equal(zen.overlay.selectedTitle, "C");
    zen.press("ArrowLeft");
    assert.equal(zen.overlay.selectedTitle, "A");
    zen.press("ArrowUp");
    assert.equal(zen.overlay.selectedTitle, "B");

    const enter = zen.press("Enter");
    assert.equal(enter.defaultPrevented, true);
    assert.equal(zen.selectedLabel, "B");
    assert.equal(zen.overlay.isOpen, false);
  });

  it("cancels on Escape and stays on the current tab", () => {
    const zen = zenWithRecentTabs();
    openSwitcher(zen);

    const escape = zen.press("Escape");
    zen.releaseCtrl();

    assert.equal(escape.defaultPrevented, true);
    assert.equal(zen.selectedLabel, "C");
    assert.equal(zen.overlay.isOpen, false);
  });

  it("cancels when the window loses focus", () => {
    const zen = zenWithRecentTabs();
    openSwitcher(zen);

    zen.blurWindow();
    zen.releaseCtrl();

    assert.equal(zen.selectedLabel, "C");
    assert.equal(zen.overlay.isOpen, false);
  });

  it("cancels before the overlay appears and never shows it", () => {
    const zen = zenWithRecentTabs();

    zen.holdCtrl();
    zen.pressTab();
    zen.press("Escape");
    zen.wait(SHOW_DELAY_MS);

    assert.equal(zen.overlay.isOpen, false);
  });

  it("switches to a card when it is clicked", () => {
    const zen = zenWithRecentTabs();
    openSwitcher(zen);

    zen.overlay.cards[2].click();

    assert.equal(zen.selectedLabel, "A");
    assert.equal(zen.overlay.isOpen, false);
  });

  it("shows each tab's icon, with a default icon when the tab has none", () => {
    const zen = new ZenWindowDriver({
      tabs: [{ label: "A", attributes: { image: "https://a.example/favicon.ico" } }, "B"],
    }).loadScript();

    openSwitcher(zen);

    assert.deepEqual(zen.overlay.icons, [
      "https://a.example/favicon.ico",
      "chrome://global/skin/icons/defaultFavicon.svg",
    ]);
  });
});

describe("tabs offered by the switcher", () => {
  it("does nothing when there is only one tab", () => {
    const zen = new ZenWindowDriver({ tabs: ["A"] }).loadScript();

    zen.holdCtrl();
    zen.pressTab();
    zen.wait(SHOW_DELAY_MS);
    zen.releaseCtrl();

    assert.equal(zen.selectedLabel, "A");
    assert.equal(zen.overlay.isOpen, false);
  });

  it("leaves out Zen's empty new-tab placeholder", () => {
    const zen = new ZenWindowDriver({
      tabs: ["A", { label: "Empty", attributes: { "zen-empty-tab": "true" } }, "B"],
    }).loadScript();

    openSwitcher(zen);

    assert.deepEqual(zen.overlay.titles, ["A", "B"]);
  });

  it("shows the active space, Essentials and tabs without a space", () => {
    const zen = new ZenWindowDriver({
      activeSpace: "work",
      tabs: [
        { label: "Work", attributes: { "zen-workspace-id": "work" } },
        { label: "Home", attributes: { "zen-workspace-id": "home" } },
        { label: "Essential", attributes: { "zen-workspace-id": "home", "zen-essential": "true" } },
        "No space",
      ],
    }).loadScript();

    openSwitcher(zen);

    assert.deepEqual([...zen.overlay.titles].sort(), ["Essential", "No space", "Work"]);
  });

  it("shows tabs from every space when the setting is on", () => {
    const zen = new ZenWindowDriver({
      activeSpace: "work",
      tabs: [
        { label: "Work", attributes: { "zen-workspace-id": "work" } },
        { label: "Home", attributes: { "zen-workspace-id": "home" } },
      ],
    }).loadScript();
    zen.setPref("all_spaces", true);

    openSwitcher(zen);

    assert.deepEqual(zen.overlay.titles, ["Work", "Home"]);
  });

  it("limits the number of cards", () => {
    const zen = new ZenWindowDriver({ tabs: ["A", "B", "C", "D", "E"] }).loadScript();
    zen.setPref("max_tabs", "3");

    openSwitcher(zen);

    assert.equal(zen.overlay.titles.length, 3);
  });

  it("accepts the card limit as an integer pref", () => {
    const zen = new ZenWindowDriver({ tabs: ["A", "B", "C", "D"] }).loadScript();
    zen.setPref("max_tabs", 2);

    openSwitcher(zen);

    assert.equal(zen.overlay.titles.length, 2);
  });

  it("falls back to 9 cards when the limit is invalid or below 2", () => {
    const tabs = Array.from({ length: 12 }, (_, i) => `Tab ${i}`);
    for (const invalid of ["abc", "1", ""]) {
      const zen = new ZenWindowDriver({ tabs }).loadScript();
      zen.setPref("max_tabs", invalid);

      openSwitcher(zen);

      assert.equal(zen.overlay.titles.length, 9, `max_tabs = "${invalid}"`);
    }
  });

  it("shows the overlay immediately when the delay is 0", () => {
    const zen = zenWithRecentTabs();
    zen.setPref("show_delay", "0");

    zen.holdCtrl();
    zen.pressTab();

    assert.equal(zen.overlay.isOpen, true);
  });

  it("uses the default delay when the delay setting is negative", () => {
    const zen = zenWithRecentTabs();
    zen.setPref("show_delay", "-5");

    zen.holdCtrl();
    zen.pressTab();
    zen.wait(SHOW_DELAY_MS - 1);
    assert.equal(zen.overlay.isOpen, false);
    zen.wait(1);
    assert.equal(zen.overlay.isOpen, true);
  });
});

describe("keys outside the switcher", () => {
  it("ignores Ctrl+Tab combined with Alt or Cmd", () => {
    const zen = zenWithRecentTabs();

    zen.holdCtrl();
    const withAlt = zen.pressTab({ alt: true });
    const withCmd = zen.pressTab({ meta: true });
    zen.releaseCtrl();

    assert.equal(withAlt.defaultPrevented, false);
    assert.equal(withCmd.defaultPrevented, false);
    assert.equal(zen.selectedLabel, "C");
  });

  it("leaves Escape, Enter and arrows alone when not switching", () => {
    const zen = zenWithRecentTabs();

    for (const key of ["Escape", "Enter", "ArrowRight", "ArrowLeft"]) {
      assert.equal(zen.press(key).defaultPrevented, false, key);
    }
  });
});

describe("recent-use order", () => {
  it("puts newly opened background tabs last", () => {
    const zen = zenWithRecentTabs();
    zen.openTab("D");

    openSwitcher(zen);

    assert.deepEqual(zen.overlay.titles, ["C", "B", "A", "D"]);
  });

  it("makes the tab chosen in the switcher the most recent one", () => {
    const zen = zenWithRecentTabs();
    openSwitcher(zen, { times: 2 });
    zen.releaseCtrl();

    openSwitcher(zen);

    assert.deepEqual(zen.overlay.titles, ["A", "C", "B"]);
  });

  it("does not count a tab that something else selects while the switcher is open", () => {
    const zen = new ZenWindowDriver({ tabs: ["A", "B", "C", "D"] }).loadScript();
    zen.visit("A", "B", "C", "D");
    openSwitcher(zen);

    zen.visit("A"); // e.g. a page focuses its tab while Ctrl is held
    zen.releaseCtrl();
    openSwitcher(zen);

    assert.deepEqual(zen.overlay.titles, ["C", "D", "B", "A"]);
  });

  it("counts the picked tab even when something else selected it during the switch", () => {
    const zen = new ZenWindowDriver({ tabs: ["A", "B", "C", "D"] }).loadScript();
    zen.visit("A", "B", "C", "D");
    openSwitcher(zen, { times: 3 });
    assert.equal(zen.overlay.selectedTitle, "A");

    zen.visit("A");
    zen.releaseCtrl();
    zen.visit("B");
    zen.tapCtrlTab();

    assert.equal(zen.selectedLabel, "A");
  });

  it("forgets closed tabs", () => {
    const zen = zenWithRecentTabs();
    zen.closeTab("B");

    zen.tapCtrlTab();

    assert.equal(zen.selectedLabel, "A");
  });
});

describe("closing tabs while switching", () => {
  it("removes the closed tab's card and keeps a valid selection", () => {
    const zen = zenWithRecentTabs();
    openSwitcher(zen, { times: 2 });
    assert.equal(zen.overlay.selectedTitle, "A");

    zen.closeTab("A");

    assert.deepEqual(zen.overlay.titles, ["C", "B"]);
    assert.equal(zen.overlay.selectedTitle, "B");
  });

  it("cancels when fewer than two tabs remain", () => {
    const zen = new ZenWindowDriver({ tabs: ["A", "B"] }).loadScript();
    openSwitcher(zen);

    zen.closeTab("B");
    zen.releaseCtrl();

    assert.equal(zen.overlay.isOpen, false);
    assert.equal(zen.selectedLabel, "A");
  });
});

describe("page previews", () => {
  const page = () => renderedPage({ width: 1200, height: 800 });

  it("shows a snapshot of pages that were viewed, scaled down to 560px", async () => {
    const zen = new ZenWindowDriver({
      tabs: [{ label: "A", page: page() }, { label: "B", page: page() }, { label: "C", page: page() }],
    }).loadScript();
    await zen.waitForPreviews(PREVIEW_CAPTURE_DELAY_MS);
    zen.visit("B");

    zen.holdCtrl();
    zen.pressTab();
    await zen.waitForPreviews(SHOW_DELAY_MS);

    assert.deepEqual(zen.overlay.titles, ["B", "A", "C"]);
    const [current, previous, neverViewed] = zen.overlay.previews;
    assert.match(current, /^data:image\/jpeg;560x/);
    assert.match(previous, /^data:image\/jpeg;560x/);
    assert.equal(neverViewed, null);
  });

  it("does not snapshot a tab that is viewed only briefly", async () => {
    const zen = new ZenWindowDriver({
      tabs: [{ label: "A", page: page() }, { label: "B", page: page() }],
    }).loadScript();
    zen.visit("B");
    await zen.waitForPreviews(PREVIEW_CAPTURE_DELAY_MS - 1);
    zen.visit("A");
    await zen.waitForPreviews(1);

    zen.holdCtrl();
    zen.pressTab();
    await zen.waitForPreviews(SHOW_DELAY_MS);

    assert.equal(zen.overlay.previews[1], null);
  });

  it("skips tabs that are not loaded yet", async () => {
    const zen = new ZenWindowDriver({
      tabs: ["A", { label: "Unloaded", page: page(), attributes: { pending: "true" } }],
    }).loadScript();
    zen.visit("Unloaded");
    await zen.waitForPreviews(PREVIEW_CAPTURE_DELAY_MS);

    openSwitcher(zen);
    await zen.waitForPreviews();

    assert.deepEqual(zen.overlay.previews, [null, null]);
  });

  it("shows a card without a preview when the snapshot fails", async () => {
    const zen = new ZenWindowDriver({
      tabs: [{ label: "A", page: renderedPage({ failSnapshot: true }) }, "B"],
    }).loadScript();
    await zen.waitForPreviews(PREVIEW_CAPTURE_DELAY_MS);

    openSwitcher(zen);
    await zen.waitForPreviews();
    zen.releaseCtrl();

    assert.equal(zen.selectedLabel, "B");
    assert.deepEqual(zen.consoleErrors, []);
  });
});

describe("lifecycle", () => {
  it("waits for the browser UI before starting", () => {
    const zen = new ZenWindowDriver({ browserReady: false }).loadScript();
    zen.wait(BOOT_RETRY_MS);
    assert.equal(zen.pressTab().defaultPrevented, false);

    zen.makeBrowserReady();
    zen.wait(BOOT_RETRY_MS);
    zen.visit("B");
    zen.tapCtrlTab();

    assert.equal(zen.selectedLabel, "A");
  });

  it("waits for the window to finish loading", () => {
    const zen = new ZenWindowDriver({ documentReady: false }).loadScript();
    assert.equal(zen.pressTab().defaultPrevented, false);

    zen.finishDocumentLoad();
    zen.visit("B");
    zen.tapCtrlTab();

    assert.equal(zen.selectedLabel, "A");
  });

  it("replaces the previous instance when the script is loaded again", () => {
    const zen = zenWithRecentTabs();
    openSwitcher(zen);

    zen.loadScript();
    openSwitcher(zen);

    assert.equal(zen.overlay.count, 1);
    assert.equal(zen.overlay.selectedTitle, "B");
    assert.equal(zen.window.listenerCount("keydown"), 1);
    assert.equal(zen.gBrowser.tabContainer.listenerCount("TabSelect"), 1);
  });

  it("removes its overlay and listeners when unloaded", () => {
    const zen = zenWithRecentTabs();
    openSwitcher(zen);

    zen.window.__betterTabSwitcher.destroy();

    assert.equal(zen.overlay.count, 0);
    assert.equal(zen.window.__betterTabSwitcher, undefined);
    for (const type of ["keydown", "keyup", "blur"]) {
      assert.equal(zen.window.listenerCount(type), 0, type);
    }
    for (const type of ["TabSelect", "TabOpen", "TabClose"]) {
      assert.equal(zen.gBrowser.tabContainer.listenerCount(type), 0, type);
    }
    zen.releaseCtrl();
    assert.equal(zen.selectedLabel, "C");
  });
});
