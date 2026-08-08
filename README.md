# ATLAS v1.0.0 — Complete Field Instrument

ATLAS is a browser-first reverse-engineering Field Instrument for inspecting binaries and firmware locally. v1.0.0 is the first integrated release: the binary explorer, real core disassemblers, program analyzer, CODE ATLAS, graphs, persistent annotations, evidence notebook, x86/x86-64 decompiler foundation, firmware workspace, Binary Diff, report/export system, and optional localhost debugger bridge now ship as one coherent instrument.

ATLAS is intended for software, firmware, and devices you own or are authorized to inspect.

## Start here

For static analysis, open:

`atlas-v1.0.0.html`

No server is required. Drag a binary onto the window or use **LOAD BINARY**.

For live native debugging, start the optional bridge from the package directory:

### macOS / Linux

```sh
./start-atlas-bridge.sh /path/to/project-or-build-root
```

### Windows Command Prompt

```bat
start-atlas-bridge.cmd C:\path\to\project-or-build-root
```

### Windows PowerShell

```powershell
.\start-atlas-bridge.ps1 -Root C:\path\to\project-or-build-root
```

The bridge prints a localhost ATLAS URL and a random token. Open the local URL, switch to **ADVANCED → DEBUGGER**, paste the token, and connect.

## v1.0 workflow

ATLAS follows:

**LOAD → IDENTIFY → MAP → DISASSEMBLE → DECOMPILE → TRACE → DEBUG → ANNOTATE → EXPORT**

The instrument exposes uncertainty and limitations rather than generating synthetic results for unsupported operations.

## Easy Mode

v1.0 substantially simplifies Easy Mode. It exposes the primary analysis path only:

- Overview
- CODE ATLAS
- Program Map
- Disassembly
- Pseudocode
- Strings
- Notes
- Export Report

The Overview now includes **Recommended Next** and **Analysis Readiness** panels. They surface decoder status, implemented-encoding coverage, unknown decoded bytes, and accumulated evidence without turning those metrics into a false confidence score.

## Advanced Mode

Advanced adds the specialist workspaces:

- Firmware
- Graph
- Annotations
- Hex
- Entropy
- Analysis Log
- Debugger
- Binary Diff

Switching to an Advanced-only workspace from the command palette automatically exposes Advanced Mode.

## Command palette

Press:

- `Ctrl+K` on Windows/Linux
- `Cmd+K` on macOS

The palette searches:

- workspaces
- project/file actions
- export actions
- discovered functions
- extracted strings

It also provides **Go to address**, mode switching, theme switching, project save, and report navigation.

## Navigation history

ATLAS v1.0 adds real analysis navigation history.

- Header **← / →** buttons move backward and forward through visited workspaces/addresses.
- `Alt+Left` / `Alt+Right` perform the same actions.
- Address jumps and function navigation are recorded as analysis locations rather than browser page history.

## Binary Explorer

ATLAS performs local binary identification and supports real parsing/detection for the formats currently implemented, including:

- ELF parsing
- PE/COFF parsing
- Mach-O identification
- WebAssembly identification
- raw binary
- Intel HEX identification
- Motorola S-record identification
- UF2 identification

It also provides:

- SHA-256
- sections/regions
- image base and entry point where available
- strings
- entropy
- binary/program map
- hex inspection and search

## Disassembly and program analysis

Browser-local instruction decoders currently cover substantial core subsets of:

- x86
- x86-64
- Cortex-M / Thumb

ATLAS builds real analysis objects from decoded evidence:

- instructions
- probable functions
- basic blocks
- branches
- direct calls
- returns
- code/data XREFs
- string references
- function confidence/evidence

Unsupported encodings remain visible as undecoded bytes or `.hword` data rather than guessed instructions.

## CODE ATLAS

CODE ATLAS is ATLAS's signature whole-program view.

It turns the program into an explorable landscape where:

- executable sections form territories
- discovered functions form regions
- direct calls form connections
- referenced strings and user symbols form satellites/context
- high-connectivity functions become landmarks
- unmapped executable spans remain visible as unknown territory

Analyst renames, bookmarks, comments, symbols, and evidence notes change the map as the investigation develops.

## Graphs

Advanced Mode provides:

- function control-flow graphs
- program call graph
- pan/zoom
- node dragging
- incoming/outgoing traversal
- depth controls
- subtree isolation
- SVG export
- Graphviz DOT export

CFG nodes are generated from discovered basic blocks; call edges come from decoded direct-call XREFs.

## Annotation and evidence system

ATLAS projects persist:

- function renames
- address labels
- comments
- bookmarks
- symbols
- structures
- unions
- enums
- typedefs
- function signatures
- notes
- tags
- analysis history

Evidence notes may be classified as:

- OBSERVATION
- HYPOTHESIS
- QUESTION
- FINDING
- NOTE

Notes retain address/function/view context where available.

## Decompiler foundation

For supported x86/x86-64 code, ATLAS LIR v0.6 remains the current decompiler foundation inside the v1.0 release.

Pipeline:

**decoded instructions → basic blocks → ATLAS LIR → expression/data-flow recovery → C-like pseudocode**

Capabilities include:

- stack-local recovery
- x86-64 ABI argument recovery
- register-expression propagation
- arithmetic/bitwise expressions
- shifts
- CMP/TEST condition reconstruction
- direct calls
- return-value reconstruction
- explicit `phi(...)` merges when control-flow values cannot yet be responsibly rewritten into higher-level source structure
- persistent analyst variable names/types
- assembly ↔ pseudocode source correlation
- IR export
- pseudocode export

Decompiler statements expose KNOWN / INFERRED / USER DEFINED / UNKNOWN evidence states. Thumb decompilation is not implemented in v1.0.

## Firmware workspace

Advanced → Firmware provides:

- raw-image base address
- architecture profile
- endianness
- editable FLASH/ROM/RAM/MMIO/OTHER memory regions
- Cortex-M architectural map template
- Cortex-M vector-table detection
- reset/interrupt handler labeling
- firmware evidence findings
- Cortex-M/Thumb disassembly
- integration of vector-derived handlers with functions, XREFs, CFGs, and CODE ATLAS

Firmware heuristics are labeled with confidence and are not asserted as facts without evidence.

## Binary Diff

Advanced → Diff compares Image A and Image B locally.

It provides:

- sections
- strings
- functions
- UNCHANGED / MODIFIED / ADDED / REMOVED classification
- architecture-aware function matching
- normalized instruction fingerprints
- instruction-bigram similarity
- size/block/call evidence
- adjustable similarity threshold
- synchronized side-by-side disassembly
- JSON / CSV / Markdown diff export

Saved projects retain the comparison summary and Image B identity/hash. Reload Image B to restore byte-level side-by-side analysis.

## Optional Debug Bridge

The bridge is a zero-dependency Node.js localhost service supporting real debugger protocols:

- GDB / MI2
- LLDB / DAP

Capabilities are enabled only when the connected adapter reports support.

The debugger workspace can provide:

- launch
- continue/run
- pause
- stop
- restart where supported
- instruction step into / over
- step out
- GDB run-to-cursor
- persistent execution breakpoints
- conditional breakpoints where supported
- registers
- changed-register highlighting
- backtrace/stack
- read-only process memory
- explicit runtime slide/load bias
- breakpoint resynchronization
- PC → static disassembly follow
- STOP TRACE evidence

STOP TRACE records debugger stops, not every executed instruction.

## Bridge security model

The bridge intentionally remains narrow:

- binds only to `127.0.0.1`
- random token authentication by default
- launch paths restricted beneath `--allow-root`
- debugger processes launched without a shell
- no arbitrary shell RPC
- no arbitrary GDB/LLDB console passthrough
- individual memory reads capped at 64 KiB
- breakpoint count capped
- sessions terminated when the bridge/client closes

The token is never written into ATLAS project files.

## Project format

New saves use:

`ATLAS_PROJECT_1.0.0`

ATLAS v1.0 continues to load earlier `ATLAS_PROJECT_*` project files. Missing newer fields are normalized to current defaults. Saving the migrated project writes the v1.0 format.

Project files can be saved as:

- external-binary reference projects
- self-contained `SAVE+BINARY` projects

Autosave retains project metadata/annotations locally. It does not silently persist arbitrary binary bytes.

## Export

ATLAS can export the evidence it actually has in formats including:

- Markdown analysis report
- JSON analysis package
- strings CSV
- functions CSV
- annotations JSON
- analysis log JSON
- pseudocode
- ATLAS IR JSON
- CFG/call graph SVG
- Graphviz DOT
- Binary Diff JSON
- Binary Diff function CSV
- Binary Diff Markdown report
- Debug stop trace JSON

## Keyboard controls

Global:

- `Ctrl/Cmd+O` — load binary
- `Ctrl/Cmd+S` — save project
- `Ctrl/Cmd+K` — command palette
- `Alt+Left` — history back
- `Alt+Right` — history forward
- `G` — go to disassembly/address control
- `F` — focus function filter
- `A` — CODE ATLAS
- `P` — pseudocode
- `W` — firmware
- `D` — Binary Diff
- `N` — rename selected function in disassembly
- `;` — comment selected instruction
- `Space` — graph/disassembly toggle for selected function

Debugger:

- `F2` — breakpoint at selected instruction
- `F7` — step into
- `F8` — step over
- `F9` — run/continue

## Transparent v1.0 limitations

ATLAS v1.0 is a complete Field Instrument release, not a claim of feature parity with mature native reverse-engineering suites.

Current declared limitations include:

- x86/x86-64 decoder is a substantial core subset, not the complete ISA
- Thumb decoder covers common Cortex-M/Thumb forms, not all Thumb-2 encodings
- Thumb decompilation is not implemented
- PE/ELF parsing does not yet expose every import/export/relocation/debug-metadata structure requested in the long-term specification
- Intel HEX, S-record, and UF2 are identified but not yet fully flattened into normalized address spaces
- live debugging requires an installed GDB or LLDB-DAP backend
- native process attach is not exposed
- OpenOCD/QEMU/remote-device debugging are future integrations
- watchpoints are not exposed
- continuous instruction tracing is not implemented
- runtime PIE/ASLR load bias remains explicit instead of automatically inferred
- library clustering in CODE ATLAS remains conservative until real module/import provenance is available
- decompiler high-level structure recovery remains intentionally conservative

## Validation performed for v1.0

The release was checked with:

- browser JavaScript syntax validation
- bridge JavaScript syntax validation
- bridge parser/security self-tests
- Easy Mode workspace audit
- Advanced Mode workspace audit
- Overview recommendation/readiness rendering
- command-palette workspace search
- command-palette discovered-function search
- navigation back/forward
- x86/x86-64 disassembly/program-analysis regression
- CODE ATLAS regression
- x86/x86-64 decompiler regression
- two-image Binary Diff regression
- v1.0 project persistence
- v0.9 project backward-load compatibility
- Markdown report export/version check
- Cortex-M firmware/vector-table regression
- browser → localhost bridge → deterministic GDB/MI2 protocol regression including breakpoints, launch, registers, stack, memory, stepping, and stop trace
- zero browser page errors in the exercised regression workflows

The build container still does not provide a usable production debugger backend. Live debugger transport/protocol behavior was therefore exercised with deterministic MI/DAP-compatible harnesses, as in v0.9, rather than claiming a production GDB/LLDB inferior was stepped in this environment.

## What v1.0 means

v1.0 marks the completion of the original incremental build sequence. Future work should now be treated as post-1.0 capability expansion rather than unfinished scaffolding: broader ISA support, richer binary-format metadata, symbol/source integrations, MCU/SVD databases, RTOS awareness, stronger decompiler structure recovery, QEMU/OpenOCD/WebUSB integrations, dynamic coverage/heatmaps, and reproducible collaborative investigation packages.

## Repository layout

- `index.html` — repository/GitHub Pages entry point for the current stable ATLAS build
- `atlas-v1.0.0.html` — versioned standalone browser build
- `atlas-bridge.js` — optional localhost GDB/LLDB debugger bridge
- `start-atlas-bridge.*` — bridge launchers for macOS/Linux and Windows
- `BRIDGE-PROTOCOL.md` — localhost bridge protocol and security model
- `CHANGELOG.md` — v1.0.0 release history
- `SHA256SUMS.txt` — release checksums

`index.html` is intentionally a copy of the current stable standalone build so the repository can be served directly by GitHub Pages without a build step.
