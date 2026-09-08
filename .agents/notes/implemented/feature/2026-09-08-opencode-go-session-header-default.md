# Agent Note: OpenCode Go receives a default session header

Status: implemented

English | [中文](2026-09-08-opencode-go-session-header-default.zh.md)

## Problem

OpenCode Go requires every model request to identify the current conversation with `x-opencode-session`. The adapter already supports dynamic session headers, but a deployment had to repeat the provider-specific setting in its user settings before the packaged route could use it.

## Decision

`dsh-llm-pi-ai` resolves `opencode-go` without an explicit `sessionHeader` to `x-opencode-session` during profile resolution. An explicit profile value remains authoritative for providers that use another field name. The adapter fills the resolved field with `GenerateOptions.sessionId` for model requests, replaces a same-named static header when a session id exists, and omits the dynamic field when a direct request has no session id. Model discovery remains free of session headers because it has no conversation session.

The default is a provider protocol requirement, not a deployment credential or endpoint. The provider profile remains optional, so this default does not activate an OpenCode Go route or add its models to the default picker; it applies when a route is configured through the existing settings or composition layers.

## Alternatives considered

**Add an `opencode-go` profile to the shared base bundle.** Rejected because it would activate the route and expose OpenCode Go models in every base-backed profile, even when a deployment only wants another provider's catalog. The provider-specific default belongs in profile resolution and preserves the existing dormant route behavior.

**Keep the value only in each deployment's `settings.yaml`.** Rejected because packaged deployments would continue to require a machine-local edit for a fixed provider protocol requirement.

**Inject the fallback inside the request execution path.** Rejected because request execution should consume the resolved profile, while profile resolution is the explicit place that applies defaults and validates the resulting header name.

## Consequences

Configured `opencode-go` routes send the required dynamic header without a repeated `sessionHeader` entry, while explicit values and the existing static-header collision rule remain supported. Other provider routes retain the absent default. Unit and real Loader-composition coverage verify resolution, override precedence, and a model request through the adapter; the package and user guides describe the provider-specific default.
