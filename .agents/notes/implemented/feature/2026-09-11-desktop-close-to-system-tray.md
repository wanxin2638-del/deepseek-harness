# Agent Note: Desktop close action keeps the backend available in the system tray

Status: implemented

English | [中文](2026-09-11-desktop-close-to-system-tray.zh.md)

## Problem

The desktop shell hosts a backend process that can continue serving the Web UI while its window is hidden. Treating every window close as process exit prevents users from keeping that session available in the Windows notification area.

## Decision

The main process intercepts the window `close` event and asks whether to minimize to the system tray or exit. Minimizing hides the window, creates a tray icon on demand, and keeps the backend process alive. The tray menu restores and focuses the window or exits the application. An application quit already in progress bypasses the prompt and destroys the tray icon during teardown. A second launch restores the hidden window.

## Alternatives considered

- **Always exit on window close** — rejected because it stops the backend and discards the user's active desktop session when the user only intended to dismiss the window.
- **Always minimize to the tray** — rejected because users need an explicit, discoverable way to stop the backend and exit the application.
- **Persist a close-behavior preference** — deferred because the requested behavior is an explicit choice for each close and does not require another settings contract.

## Consequences

The application remains resident after a tray choice, so the backend and its session state continue running until the user chooses Exit from the tray menu. The native close prompt uses English labels consistent with the existing desktop main-process dialogs. Close-choice paths are covered by the desktop main-process tests.

