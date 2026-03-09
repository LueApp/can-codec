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
│   ├── example_damiao.yaml      # Damiao Motor (multi-node)
│   └── your_mavlink.xml   # MAVLink XML definitions
├── canfd_codec/          # Python package
│   ├── codec.py          # Core engine: config loading, bit pack/unpack, encode/decode
│   ├── cli.py            # CLI entry point (argparse, 5 subcommands)
│   ├── monitor.py        # Live CAN bus monitor (requires python-can)
│   └── mavlink_loader.py # MAVLink XML message definition parser
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

- **cli.py** — CLI entry point with 5 subcommands: `list`, `describe`, `decode`, `encode`, `monitor`. The `-c`/`--config` flag is global and must come before the subcommand.

- **monitor.py** — Live CAN bus monitor (requires `python-can`). Two modes: scrolling real-time display (`Monitor`) and live-updating summary table (`SummaryMonitor`).

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

Edit the four `_extract_bits_*` / `_pack_bits_*` functions in `codec.py`.

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

### MAVLink XML Support

The codec can load MAVLink XML message definition files directly. Place `.xml` files in the config directory alongside YAML files.

```bash
# Load a single MAVLink XML file
canfd-codec -c ./message_definitions/your_mavlink.xml list

# Encode a MAVLink message
canfd-codec -c ./your_mavlink.xml encode SET_DAC target_system=1 target_component=1 dac=12345678

# Output in MAVLink CAN transport format (29-bit extended ID)
canfd-codec -c ./configs encode ARM_MODE_SWITCH mode=idle --mavlink --sys-id 1 --comp-id 1
# => vcan0 00010101##1FD01000000010136F200002B81

# Encode with array syntax (expands position=[...] to position_0, position_1, etc.)
canfd-codec -c ./configs encode ARM_CSP_CMD 'position=[0.0,0.5,1.0,1.5,2.0,2.5,3.0]' --mavlink --sys-id 1 --comp-id 1
# Large messages are automatically split into multiple CAN FD frames (max 64 bytes each):
# => vcan0 00010101##1FD5400000001013BF20000000000...  (frame 1: 64 bytes)
# => vcan0 00010101##1000000000000000000000000...      (frame 2: 32 bytes)
```

**Decoding MAVLink CAN frames:**

The `--mavlink` flag enables MAVLink CAN transport decoding. It automatically parses:
- 29-bit extended CAN ID to extract system/component IDs
- Full MAVLink v2 frames (detects 0xFD magic byte) to extract message ID and payload

```bash
# Decode a MAVLink v2 frame over CAN transport
canfd-codec -c ./configs decode 0x00010101 "FD 01 00 00 00 01 01 36 F2 00 00 2B 81" --mavlink
# MAVLink: sys_id=1, comp_id=1, msg_id=0xF236, seq=0
# [0x10101] ARM_MODE_SWITCH: Switch robot arm control mode
#   mode: idle
```

MAVLink v2 frame structure (automatically parsed):
```
┌────┬─────┬─────────┬────────┬─────┬────────┬──────────┬───────────┬─────────┬───────┐
│0xFD│ len │ incompat│ compat │ seq │ sys_id │ comp_id  │ msg_id[3] │ payload │ crc[2]│
└────┴─────┴─────────┴────────┴─────┴────────┴──────────┴───────────┴─────────┴───────┘
```

CAN ID format (29-bit extended):
```
┌──────────┬──────────┬─────────────┬─────────────────────────┐
│ Bit 28:17│ Bit 16   │ Bit 15:8    │ Bit 7:0                 │
│ Reserved │ MAVLink=1│ System ID   │ Component ID            │
└──────────┴──────────┴─────────────┴─────────────────────────┘
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
