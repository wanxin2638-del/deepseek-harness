# Agent Note: All pending user interactions trigger desktop attention

Status: implemented

English | [中文](2026-09-08-all-pending-user-interactions-trigger-desktop-attention.zh.md)

## Problem

The Web Client exposes approvals, questions, and plan reviews through the shared `uiSession.pendingInteractions` registry. A desktop reminder that recognizes only approval items leaves question and plan-review cards without taskbar attention. A pending interaction can also appear while the shell is focused; if the plugin checks `unfocusedOnly` only at the appearance edge, switching away afterward never starts the flash.

## Decision

`@deepseek-ai/dsh-client-desktop-integration` treats every entry in `uiSession.pendingInteractions` as requiring user attention. The C2 switch is named `flashOnInteraction`, and the plugin requests `flash({ kind: 'until-focus' })` while at least one interaction remains pending and the window is eligible for reminders. The plugin re-evaluates the pending set after the initial window-state read and on every window-state transition, so a pending interaction that becomes unfocused starts flashing. Removing the last pending item calls `flashClear()`.

The shell remains responsible only for the flash primitive and clearing it when the window receives focus. Approval, question, and plan-review producers continue to own their pending carriers and settlement paths.

## Alternatives considered

- **Keep the approval-only filter** — rejected because it does not cover the other user-interaction carriers already published by `uiSession.pendingInteractions`.
- **Flash only when the pending set changes** — rejected because a pending item may remain unchanged while the window changes from focused to unfocused.
- **Remove the `unfocusedOnly` condition** — rejected because it would make a taskbar attention request when the user is already viewing the interaction, changing the existing reminder policy.

## Consequences

- Question and plan-review requests receive the same persistent taskbar attention as approvals.
- The existing `unfocusedOnly` behavior remains configurable; a pending interaction appearing while focused is picked up when the shell later reports an unfocused state.
- Deployments using the old `flashOnApproval` configuration key must use `flashOnInteraction`; the client configuration is pre-stable.

## Testing

The desktop-integration behavior suite covers approval, question, and plan-review pending items, release clearing, and a question that appears while focused and starts flashing after a focus transition. The suite continues to cover the no-bridge and disposal paths.
