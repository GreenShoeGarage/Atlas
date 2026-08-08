# ATLAS v1.0.0 Changelog

## Release: Complete Field Instrument

v1.0.0 is the integration/cleanup milestone completing the original v0.1 → v1.0 build sequence.

### Integrated capabilities retained

- local binary loading and identification
- SHA-256, strings, entropy, hex and binary mapping
- PE/ELF parsing plus additional format identification
- x86/x86-64 core disassembly
- Cortex-M/Thumb core disassembly
- function discovery, basic blocks and XREFs
- CFG and call graph
- CODE ATLAS
- persistent annotation/type/evidence system
- ATLAS LIR x86/x86-64 decompiler foundation
- raw firmware workspace and Cortex-M vector analysis
- two-image Binary Diff
- optional GDB/MI2 and LLDB-DAP localhost Debug Bridge
- project autosave, import/export and reporting
- dark/light themes

## New in v1.0

### Easy Mode cleanup

Easy Mode is now intentionally limited to the primary analysis workflow:

- Overview
- CODE ATLAS
- Program Map
- Disassembly
- Pseudocode
- Strings
- Notes
- Export Report

Firmware, Graph, Annotations, Hex, Entropy, Analysis Log, Debugger, and Diff now live in Advanced Mode.

### Overview integration

Added:

- Recommended Next panel
- Analysis Readiness panel
- implemented-decoder coverage visibility
- unknown-byte visibility
- accumulated evidence count
- explicit Easy Mode workflow explanation

### Command palette

Added `Ctrl/Cmd+K` command palette with:

- workspace search/navigation
- discovered-function search
- extracted-string search
- load/save/export actions
- Go to address
- Easy/Advanced mode switching
- theme switching

### Navigation history

Added analysis navigation history:

- header Back / Forward buttons
- `Alt+Left` / `Alt+Right`
- workspace/address/function locations
- bounded in-session history

### Project version

New saves use:

`ATLAS_PROJECT_1.0.0`

Earlier `ATLAS_PROJECT_*` files remain loadable and normalize missing fields to current defaults.

### Debug Bridge

Bridge version is now 1.0.0. Protocol behavior and security model remain compatible with v0.9; app serving now recognizes `atlas-v1.0.0.html`.

## Cleanup

- consolidated release/version wording throughout the UI and reports
- removed Advanced-only buttons from Easy Overview actions
- normalized workspace badges so they describe capability rather than old milestone numbers
- retained no-fake-features messaging for unsupported decoders/decompilers/debuggers
- preserved earlier annotation, diff, firmware and debugger persistence behavior

## Validation

Passed:

- Node syntax checks for application JavaScript and bridge
- ATLAS Bridge self-test (6/6 checks)
- focused Easy Mode navigation test
- full Advanced workspace exposure test
- x86/x86-64 analysis/decompiler test
- CODE ATLAS navigation test
- command palette test
- navigation-history test
- Binary Diff test against two distinct x86-64 ELF revisions
- embedded v1.0 project save/version check
- v0.9 project backward-load check
- Markdown report export/version check
- Cortex-M vector/Thumb regression
- browser → bridge → deterministic GDB/MI2 live-debug protocol regression
- no JavaScript page exceptions in exercised browser workflows

## Explicit limitations retained

v1.0 does not claim full ISA coverage, full native-decompiler parity, Thumb decompilation, OpenOCD/QEMU integration, watchpoints, continuous instruction tracing, automatic PIE relocation discovery, or complete PE/ELF import/export/debug metadata support.
