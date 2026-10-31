<p align="center">
  <b>English</b> · <a href="README.ru.md">Русский</a>
</p>

<h1 align="center">Better Tab Switcher (Ctrl+Tab)</h1>

<p align="center">
  A tab switcher for <a href="https://zen-browser.app">Zen Browser</a>: page previews and the colors of your theme.
</p>

<p align="center">
  <img src="docs/screenshot.png" alt="Ctrl+Tab overlay with tab previews in Zen Browser" width="820">
</p>

## Features

- While you hold Ctrl, cards with previews of your recent tabs appear over the page. Tab moves forward, Shift+Tab moves back, releasing Ctrl opens the selected tab.
- Background, colors and accent come from the theme you configured: light, dark or gradient.
- A quick Ctrl+Tab press jumps straight to the previous tab without flashing the overlay (the show delay is configurable).
- Tabs are ordered by recent use (MRU).
- Arrow keys move the selection, Enter confirms, Esc cancels, clicking a card selects it.
- By default, tabs of the current space and Essentials are shown.

## Installation

1. In Sine open Settings and enable "Enable installing JS from unofficial sources" (`sine.allow-unsafe-js`), because the mod contains JS.
2. Install the mod from this repository with the Sine manager.
3. Restart Zen.

## Settings

| Setting | Value |
|---|---|
| Show tabs from all spaces | off by default |
| Overlay show delay, ms | number, default 150, `0` shows it immediately |
| Maximum cards | number from 2, default 9 |
