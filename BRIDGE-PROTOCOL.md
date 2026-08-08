# ATLAS Bridge Protocol v1.0

ATLAS Bridge is a loopback WebSocket service used only for optional native debugger integration.

## Transport

Default endpoint:

`ws://127.0.0.1:8765/`

Authentication token is passed in the WebSocket URL query:

`?token=<startup-token>`

The bridge binds only to `127.0.0.1`.

## Request envelope

```json
{
  "type": "request",
  "id": 1,
  "method": "bridge.hello",
  "params": {}
}
```

## Response envelope

Successful:

```json
{
  "type": "response",
  "id": 1,
  "ok": true,
  "result": {}
}
```

Failed:

```json
{
  "type": "response",
  "id": 1,
  "ok": false,
  "error": "human-readable reason"
}
```

## Event envelope

```json
{
  "type": "event",
  "event": "session.state",
  "body": {}
}
```

## Methods

### `bridge.hello`

Returns bridge version, allowed root, adapter probes, hard limits, and security capabilities.

### `session.start`

Parameters:

```json
{
  "adapter": "auto | gdb | lldb",
  "target": "/allowed/root/app",
  "args": ["--example"],
  "cwd": "/allowed/root"
}
```

The bridge canonicalizes the paths and rejects targets outside `--allow-root`.

### `session.close`

Terminates the active debugger adapter/session.

### `session.command`

Whitelisted commands:

- `run`
- `continue`
- `pause`
- `stop`
- `restart`
- `stepInto`
- `stepOver`
- `stepOut`
- `runTo` where the adapter supports it

`runTo` includes an `address` parameter.

### `session.snapshot`

Returns the current stopped-state evidence available from the backend:

- PC
- SP
- thread id
- registers
- stack frames
- stack bytes where memory reading is available
- breakpoint backend state

### `breakpoint.add`

```json
{
  "address": 4198400,
  "condition": "i == 10",
  "enabled": true
}
```

### `breakpoint.remove`

```json
{
  "id": "1"
}
```

### `breakpoint.toggle`

```json
{
  "id": "1",
  "enabled": false
}
```

### `breakpoints.list`

Returns backend breakpoint state.

### `memory.read`

```json
{
  "address": 140737488347136,
  "length": 128
}
```

Hard maximum per request: 64 KiB.

## Events

### `bridge.ready`

Sent immediately after an authenticated WebSocket connection.

### `session.state`

Possible states include:

- `ready`
- `running`
- `stopped`
- `exited`
- `terminated`

The body may include stop reason, PC, thread id, breakpoint ids, signal, or exit code depending on backend evidence.

### `session.snapshot`

Unsolicited snapshot sent by the bridge after a debugger stop when snapshot acquisition succeeds.

### `session.output`

Debugger or target output with a stream/category label.

## GDB adapter

The GDB adapter uses MI2 commands and parses MI result/async/stream records.

No user-provided arbitrary GDB console command is accepted through the bridge protocol.

## LLDB adapter

The LLDB adapter uses the Debug Adapter Protocol over stdio. It reads the adapter's `initialize` capabilities and exposes only operations ATLAS can map responsibly.

No generic DAP command passthrough is exposed.

## Security boundaries

The protocol intentionally does not expose:

- arbitrary shell execution
- arbitrary debugger console commands
- arbitrary process attach
- process-memory writing
- remote TCP debugger control
- unrestricted file access

These boundaries keep the bridge focused on the ATLAS debugging workflow rather than turning it into a general local command service.
