# OpenWolf

@.wolf/OPENWOLF.md

This project uses OpenWolf for context management. Read and follow .wolf/OPENWOLF.md every session. Check .wolf/cerebrum.md before generating code. Check .wolf/anatomy.md before reading files.


# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A configurable CAN/CAN-FD message encoder/decoder. Device-specific message layouts are defined in YAML config files. The tool converts between raw CAN frames (hex bytes) and human-readable signal names/values.

Two main use cases:
1. **CLI encode/decode** — translate frames on the command line or in scripts
2. **Live bus monitor** — attach to a CAN interface and decode frames in real time

## Project Layout

```
├── configs/              # YAML/XML device definitions (one file per device)
│   ├── example_damiao.yaml  # Example device config (Damiao motor)
│   └── your_mavlink.xml     # MAVLink XML definitions
├── canfd_codec/          # Python package
│   ├── codec.py          # Core engine: config loading, bit pack/unpack, encode/decode
│   ├── cli.py            # CLI entry point (argparse, 6 subcommands)
│   ├── monitor.py        # Live CAN bus monitor (requires python-can)
│   ├── mavlink_loader.py # MAVLink XML message definition parser
│   └── codegen/          # Per-language library generators (python/c/cpp/rust)
└── pyproject.toml
```

## Build and Run Commands

```bash
# Install (core only)
pip install -e .

# Install with live monitoring
pip install -e ".[monitor]"

# Run CLI (note: -c must come BEFORE subcommand)
canfd-codec -c ./configs list
canfd-codec -c ./configs decode 0x101 "98 3A 05 01 00 00 00 00"
canfd-codec -c ./configs encode SetSpeed target_speed=1500 direction=forward enable=on
canfd-codec -c ./configs monitor --bus vcan0

# Generate a standalone library for the device (python / c / cpp / rust)
canfd-codec -c ./configs/example_damiao.yaml genlib --lang python -o damiao.py
canfd-codec -c ./configs/example_damiao.yaml genlib --lang c      -o damiao.h
canfd-codec -c ./configs/example_damiao.yaml genlib --lang cpp    -o damiao.hpp
canfd-codec -c ./configs/example_damiao.yaml genlib --lang rust   -o damiao.rs
```

### Testing with Virtual CAN

```bash
# Set up virtual CAN interface
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan
sudo ip link set vcan0 mtu 72    # Enable CAN FD (MTU 72)
sudo ip link set up vcan0

# Send test frames
cansend vcan0 101#E803050000000000

# Roundtrip test: encode then decode
canfd-codec -c ./configs encode SetSpeed target_speed=1500 direction=forward enable=on
# => Data: [98 3A 05 00 00 00 00 00]
canfd-codec -c ./configs decode 0x101 "98 3A 05 00 00 00 00 00"
# => target_speed: 1500 rpm, direction: forward, enable: on
```

## Architecture

### Core Components

- **codec.py** — Central engine: config loading, bit pack/unpack, encode/decode. The `Codec` class loads all YAML configs from a directory, builds ID→Message and Name→Message lookup maps, and exposes `decode(id, bytes)` and `encode(name, values_dict)`.

- **cli.py** — CLI entry point with 6 subcommands: `list`, `describe`, `decode`, `encode`, `monitor`, `genlib`. The `-c`/`--config` flag is global and must come before the subcommand.

- **monitor.py** — Live CAN bus monitor (requires `python-can`). Two modes: scrolling real-time display (`Monitor`) and live-updating summary table (`SummaryMonitor`).

- **codegen/** — Per-language library generators that translate a parsed `DeviceConfig` into a single self-contained source file (Python/C/C++/Rust). Each generator (`python_gen.py`, `c_gen.py`, `cpp_gen.py`, `rust_gen.py`) emits the same algorithm as `codec.py` so the generated code is bit-exact with the master codec. `common.py` holds language-agnostic helpers (identifier sanitization, signal type → native type mapping, default value resolution).

### Bit Operations

All bit manipulation lives in four functions in `codec.py`:
- `_extract_bits_le`, `_pack_bits_le` — Intel (little-endian), linear bit numbering
- `_extract_bits_be`, `_pack_bits_be` — Motorola (big-endian), start_bit is MSB, bits snake across bytes

These operate bit-by-bit (not byte-aligned) to support signals crossing byte boundaries.

### Signal Value Types

- `unsigned` — standard integer (default)
- `signed` — two's complement
- `float32`, `float64` — IEEE 754 reinterpretation of raw bits
- **Enum** — map raw integers to named strings (bidirectional)
- **Bitfield** — map bit positions to flag names

### Physical Value Conversion

Standard formula: `physical = raw * scale + offset`

**Linear mapping mode** (`linear_map: true`): Automatically calculates scale/offset to map the full bit range to a physical min/max range:

```yaml
# Instead of manually calculating scale/offset:
- name: "temperature"
  bit_length: 8
  scale: 1.0
  offset: -40

# Use linear_map with min/max:
- name: "temperature"
  bit_length: 8
  min: -40
  max: 215
  linear_map: true
  # Auto-calculated: scale = (215 - (-40)) / 255 = 1.0, offset = -40
```

For unsigned signals: raw 0 → min, raw (2^bits - 1) → max
For signed signals: raw -(2^(bits-1)) → min, raw (2^(bits-1) - 1) → max

## Common Tasks

### Adding a new device

Create a new `.yaml` file in the config directory. The codec auto-discovers all `.yaml`, `.yml`, and `.xml` (MAVLink) files. Required signal fields: `name`, `start_bit`, `bit_length`. Everything else has sensible defaults.

### Adding a new CLI subcommand

Add a `cmd_<name>(args)` function in `cli.py`, register it in the `sub` subparser block and the `handlers` dict at the bottom of `main()`.

### Modifying bit packing logic

Edit the four `_extract_bits_*` / `_pack_bits_*` functions in `codec.py`. **If you change them, also update the runtime helpers in `canfd_codec/codegen/{python,c,cpp,rust}_gen.py`** — they re-implement the same algorithm in the target language. They must stay bit-for-bit equivalent or generated libs will diverge from the master codec.

### Adding a new codegen target

1. Create `canfd_codec/codegen/<lang>_gen.py` exporting `generate_<lang>(device: DeviceConfig) -> str`.
2. Register it in `canfd_codec/codegen/__init__.py` (add to `GENERATORS` and `EXTENSIONS`).
3. Add the language name(s) to the `choices=` list in `cli.py`'s `p_gen` subparser.
4. Mirror the bit-pack/extract helpers (LE + BE) and the signed/float reinterpret routines from `codec.py` so the generated code stays bit-exact with the master codec.

## Config YAML Schema

```yaml
device:
  name: "string"           # Device display name
  bus: "vcan0"             # Default CAN interface
  fd: true                 # CAN FD capable

messages:
  - id: 0x100              # Base CAN ID (hex, int, or binary 0b...)
    name: "MessageName"    # Unique name used for encoding
    direction: "tx"        # tx (we send) or rx (we receive)
    dlc: 8                 # Data length (classic CAN: 0-8, CAN FD: up to 64)
    node_count: 4          # Number of nodes sharing this message format (default: 1)
    node_id_offset: 1      # ID offset per node (default: 1)
    node_id_start: 0       # First node_id (default: 0)
    broadcast_node_id: 0x7F  # Special node_id for broadcast (all nodes in one frame)
    signals:
      - name: "signal_name"
        start_bit: 0       # Bit offset in payload
        bit_length: 16     # Number of bits
        byte_order: "little_endian"  # or "big_endian"
        value_type: "unsigned"       # unsigned | signed | float32 | float64
        scale: 0.1                   # physical = raw * scale + offset
        offset: 0
        min: 0                       # Physical min (for docs, or linear_map calc)
        max: 100                     # Physical max (for docs, or linear_map calc)
        linear_map: false            # If true, auto-calculate scale/offset from min/max
        unit: "rpm"
        default: 0                   # Default value when encoding (optional)
        constant: false              # If true, always uses default, not user-configurable
        enum:              # Optional: named values
          0: "off"
          1: "on"
        bitfield:          # Optional: named bit flags
          0: "flag_a"
          1: "flag_b"
```

### Default and Constant Signal Values

Use `default` and `constant` for signals that have fixed or default values:

```yaml
signals:
  # Signal with default value - used when not provided during encoding
  - name: "protocol_version"
    start_bit: 0
    bit_length: 8
    default: 1

  # Constant signal - always uses default, user cannot override
  - name: "message_type"
    start_bit: 8
    bit_length: 8
    default: 0x55
    constant: true

  # Default can also be an enum string
  - name: "mode"
    start_bit: 16
    bit_length: 8
    enum:
      0: "normal"
      1: "fast"
    default: "normal"
```

When encoding:
- `constant: true` signals always use their `default` value (user values are ignored)
- Signals with `default` use it when no value is provided
- Signals without `default` are skipped if no value is provided

### Multi-Node Messages

For systems with multiple identical devices (e.g., 7 motors), use `node_count`, `node_id_offset`, and `node_id_start`:

```yaml
messages:
  # 1-indexed: nodes 1-7 → IDs 0x481,0x482,...,0x487
  - id: 0x480             # base ID
    name: "PositionControl"
    node_count: 7
    node_id_offset: 1
    node_id_start: 1      # first valid node_id
```

Formula: `actual_id = base_id + node_id * node_id_offset`

With `node_id_start: 1`, valid node IDs are 1 through `node_id_start + node_count - 1` (i.e., 1-7).

CLI usage:
```bash
# Encode for specific node
canfd-codec -c ./configs encode PositionControl target_position=1.5 --node 1
# => ID: 0x481

# Decode automatically detects node from ID
canfd-codec -c ./configs decode 0x482 "..."
# => [0x482] PositionControl (node 2): ...
```

### Broadcast Mode

When `broadcast_node_id` is set on a multi-node message, a single CAN FD frame can address all nodes at once. The payload is the concatenation of each node's individual payload in node order.

```yaml
messages:
  - id: 0x480
    name: "PositionControl"
    node_count: 7
    node_id_offset: 1
    node_id_start: 1
    broadcast_node_id: 0x7F   # All lower 7 bits set = broadcast
```

Broadcast CAN ID = `base_id + broadcast_node_id * node_id_offset` (e.g., 0x480 + 0x7F = 0x4FF).
Broadcast payload size = `single_node_bytes * node_count` (e.g., 8 * 7 = 56 bytes).

CLI usage:
```bash
# Encode broadcast: array values distributed per-node, scalars shared
canfd-codec -c ./configs encode MITControl --broadcast \
  'position=[1.5,2.0,2.5,3.0,3.5,4.0,4.5]' velocity=0 kp=1 kd=0.01 ff=0
# => ID: 0x47F, 56 bytes

# Decode: broadcast frames are detected automatically
canfd-codec -c ./configs decode 0x47F "..."
# => [0x47F] MITControl (broadcast, 7 nodes):
#      Node 1: position=1.500 rad, ...
#      Node 2: position=2.000 rad, ...
```

### MAVLink XML Support

The codec can load MAVLink XML message definition files directly. Place `.xml` files in the config directory alongside YAML files.

```bash
# Load a single MAVLink XML file
canfd-codec -c ./message_definitions/your_mavlink.xml list

# Encode a MAVLink message
canfd-codec -c ./your_mavlink.xml encode <MSG_NAME> target_system=1 target_component=1 field=value

# Output in MAVLink CAN transport format (29-bit extended ID).
# --sys-id/--comp-id are the LOCAL sender. The target is taken from the message's
# target_system/target_component fields (or --target-sys/--target-comp); 0,0 = broadcast.
canfd-codec -c ./configs/mavlink/user_define.xml encode ARM_MODE_SWITCH \
  mode=idle target_system=1 target_component=1 --mavlink --sys-id 1 --comp-id 1
# => vcan0 10104041##1FD02000000010136F2000101118A
#    CAN ID 0x10104041 = sender 1.1 -> target 1.1

# Array fields expand (field=[v0,v1,...] -> field_0, field_1, ...). MAVLink frames
# larger than 64 bytes are automatically split into multiple CAN FD frames at the
# same CAN ID, in order.
```

**Decoding MAVLink CAN frames:**

The `--mavlink` flag enables MAVLink CAN transport decoding. It automatically parses:
- 29-bit extended CAN ID to extract the sender and target system/component IDs
- Full MAVLink v2 frames (detects 0xFD magic byte) to extract message ID and payload

```bash
# Decode a MAVLink v2 frame over CAN transport
canfd-codec -c ./configs/mavlink/user_define.xml \
  decode 0x10104041 "FD 02 00 00 00 01 01 36 F2 00 01 01 11 8A" --mavlink
# MAVLink: sender=1.1, target=1.1, msg_id=0xF236, seq=0
# [0x10104041] ARM_MODE_SWITCH: Switch robot arm control mode
#   target_system: 1
#   target_component: 1
#   mode: idle
```

MAVLink v2 frame structure (automatically parsed):
```
┌────┬─────┬─────────┬────────┬─────┬────────┬──────────┬───────────┬─────────┬───────┐
│0xFD│ len │ incompat│ compat │ seq │ sys_id │ comp_id  │ msg_id[3] │ payload │ crc[2]│
└────┴─────┴─────────┴────────┴─────┴────────┴──────────┴───────────┴─────────┴───────┘
```

CAN ID format (29-bit extended, destination-based routing — mirrors
`robot/utils/mavlink_bridge/impl/mavlink_can_transport.h`):
```
┌────────┬─────────────┬──────────────┬─────────────┬──────────────┐
│ Bit 28 │ Bits 27:20  │ Bits 19:14   │ Bits 13:6   │ Bits 5:0     │
│ Header │ sender_sys  │ sender_comp  │ target_sys  │ target_comp  │
│  = 1   │ (8 bit)     │ (6 bit, ≤63) │ (8 bit)     │ (6 bit, ≤63) │
└────────┴─────────────┴──────────────┴─────────────┴──────────────┘
  can_id = (1<<28) | (sender_sys<<20) | (sender_comp<<14)
                   | (target_sys<<6)  | target_comp
  Broadcast = target_sys == 0 && target_comp == 0.
  NOTE: component IDs are limited to 0-63 by the 6-bit fields.
```

MAVLink XML features supported:
- Enums with automatic name mapping
- All standard field types (uint8_t, int16_t, float, etc.)
- Array fields (expanded to individual signals)
- Message descriptions

## Dependencies

- **Required**: `pyyaml>=6.0`
- **Optional**: `python-can>=4.0` (live bus monitoring)
- **Python**: 3.10+ (uses `X | Y` union type syntax)

## Not Yet Implemented

- Multiplexed messages (same CAN ID, different layouts based on mux signal)
- Multi-frame / ISO-TP transport protocol reassembly
- DBC file import/export
- Config schema validation with detailed error messages
- Unit tests
