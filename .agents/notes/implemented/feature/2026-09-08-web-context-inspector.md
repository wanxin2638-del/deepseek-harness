# Agent Note: Web model context inspector

Status: implemented

English | [中文](2026-09-08-web-context-inspector.zh.md)

## Problem

The Session JSONL export records lifecycle events, request headers, and message-producing events together. A browser feature that concatenates those records cannot identify the exact model history reliably: inbox splice records can duplicate user messages, tool calls are execution records, and the loaded browser window may omit older events. Users need to inspect the complete current model context without changing Session data or activating a cold Agent.

## Decision

`SessionController` exposes a read-only `session.context` Remote method addressed by an ordinary Session or direct subagent address. The Host reads one exact live or persisted observation, restores the canonical Session representation, and returns its cursor, latest logged `request/header`, and `Session.deriveMessages()` result. The Client `SessionFace` exposes the same operation as `readContext(signal?)`.

The Chat target registers a `Context` tab beside Chat and Trajectory. The tab renders the Host result with the shared JSON tree, exposes node copy actions, refreshes after an event-window revision, and ignores stale responses from earlier reads. The target-neutral Conversation package does not register the tab, so compositions without Chat retain their existing View roster.

The response keeps the request header separate from `messages`. The header carries provider configuration, the system prompt, and tool schemas; `messages` preserves provider-neutral content blocks, tool calls, tool results, sources, and message identities. `asOfSeq` identifies the durable cut represented by both values.

## Alternatives considered

**Parse the complete JSONL export in the browser.** Rejected because it would duplicate Session surface folding and request reconstruction in a Client bundle, and would require loading the complete log before the view could be correct.

**Expose raw Session events through a new tab.** Rejected because raw lifecycle records are not the model context and would make the requested `messages` view depend on users interpreting internal event types.

**Register the tab in `ui-conversation`.** Rejected because that package is target-neutral and its existing wiring contract allows a composition without Chat to have no conversation View. The Chat target owns the product-facing context View.

## Consequences

The Host remains the single owner of context reconstruction, so compaction, surface replacement, fork prefixes, tool results, and cold Session reads use the same rules as model requests. The read is point-in-time and may be followed by a later Session revision before the browser paints; the revision-triggered refresh and generation guard make the displayed result converge without presenting an older response over a newer one. The View exposes system prompts and tool schemas to the authenticated Session reader and therefore inherits the existing Session address authorization; it adds no sharing or mutation operation.

Host and Client contract tests cover request headers, derived user messages, Remote routing, and the Client read method. The Chat View test covers initial rendering, revision refresh, and a localized failure. Web assembly and full browser acceptance remain owned by the repository's broader Web checks.
