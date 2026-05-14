# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-06

## User Preferences

- When user says "filter signals" for a message, they mean filtering by **enum values** of signals (e.g., only watch register_id=2), not toggling signal names on/off. The key use case is messages like WriteReg/ReadReg where register_id has many enum values and they want to watch only specific ones.

## Key Learnings

- **Project:** canfd-codec
- **Description:** A configurable CAN/CAN-FD message encoder/decoder. Define your device's message
- The web codec (codec.ts) `findMessageById` must match the Python codec's DLC-based disambiguation for same-ID multi-node messages. Without it, RegResponse* variants all decode as the first one registered.
- Chart.js plugin options on custom plugins need a `declare module 'chart.js'` augmentation of `PluginOptionsByType<TType>` to be type-safe. Place the augmentation in a `.d.ts` file (not inside `<script lang="ts">`, where ambient module declarations aren't allowed).
- The plot page renders three chart kinds (signals, timeline, interval) via `renderXxx()` (full rebuild) and `updateLiveXxx()` (incremental). `requestRender(false)` triggers the incremental path; `requestRender(true)` triggers full rebuild. Incremental path works in BOTH paste and live modes (reads from the same stores).

## Do-Not-Repeat

- [2026-05-06] When renaming a field in a persisted type (e.g. localStorage), always add migration/normalization logic that handles old stored data. An entry may exist with the old field name, causing undefined access on the new name. Use a normalizer that ensures all required fields exist.
- [2026-05-06] In Svelte 5, never mutate `$state` objects inside template expressions or `$derived`. Methods called from templates (like `getMessageFilter`) must be pure reads — return new objects with safe defaults instead of mutating the source. Mutations are only safe in event handlers (onclick etc.).

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
