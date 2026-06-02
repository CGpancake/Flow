# Decisions

## Unified lifecycle owner

Core owns lifecycle state. Internal modules and subagents return proposed actions/results only.

## Planning-first workflow

Nearly all work starts with `/plan`. Build is triggered only from post-plan choices.

## Gated research

External research uses `pi-web-access` inside scoped subagents through a ResearchAdapter. Parent sessions receive distilled findings only.

## Capability backends are not workflow owners

`pi-web-access` and `pi-subagents`/`pi-agents` are allowed as core architecture dependencies only behind adapters. They provide search/fetch/spawn/result capabilities, but core owns lifecycle state, plan readiness, build approval, user questions, memory, and docs decisions.

## Context-mode deferred

File-backed memory is the initial memory owner. Reconsider `context-mode` only if output bloat or retrieval needs justify it.
