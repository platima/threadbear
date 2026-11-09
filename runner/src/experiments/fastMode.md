---
id: fastMode
name: Fast mode
title: Fast mode: Claude Code's faster, pricier speed as a choice in the model picker, per thread
added: 2026-11-09
on: false
reminder: d24f7231
---

## What it does

On a Claude model that has it (Opus, for now), the model picker gets Standard and Fast under the effort levels, and `/fast` in the message box does the same. Fast is Claude Code's fast mode: the same model, answering faster, at a higher price (on a subscription it draws from usage credits). It's for that one thread, and its chip then ends in "Fast", like "Opus 5.5 · High · Fast". The new-thread picker's toggle is for the thread you're about to start, and the next one starts on Standard again. Picking a model without it puts the thread back on Standard, and if your login can't have fast mode (no usage credits, or your organization turned it off), the thread says why once and carries on at standard speed. Codex threads don't have it.

## Lives in

`checkFastMode` in `runner/src/runner/new-threads.ts`; `update` and `fastModeWhy` in `runner/src/runner.ts`; the Claude adapter's `setFastMode` and flag settings; `/fast` in `runner/src/runner/commands.ts` and `slash-commands.ts`; app `SpeedRow` in `Views/ComposerControls.swift`, `ModelPicker.offersFastMode`, `newThreadFast` in `PoolsModel.swift`

## Taking it out

Self-contained: drop `SpeedRow` from the picker and the `fast` command, and threads stay at standard speed.
