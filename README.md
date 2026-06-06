# CAN FD Codec

A configurable CAN/CAN-FD message encoder/decoder. Define your device's message
layout in YAML or MAVLink XML config files, then use the CLI or Python API to convert between
raw CAN frames and human-readable signals.

**Web UI:** [can-codec.lue-app.com](https://can-codec.lue-app.com/)

## Installation

```bash
# Core (encode/decode only)
pip install .

# With live monitoring support
pip install ".[monitor]"
```

## Web UI

The hosted Web UI at [can-codec.lue-app.com](https://can-codec.lue-app.com/) (also runnable
locally — see `web/`) provides a browser-based companion to the CLI. All processing happens
client-side; only live-bus features need the bridge server.

| Page | What it does |
|------|--------------|
| **Messages** | Browse / filter the message definitions loaded from your YAML or MAVLink XML. |
| **Decode** | Paste raw hex → see decoded signals. |
| **Encode** | Fill signal values → get hex bytes + cansend output, copy or send to the bus. |
| **Program** | Build multi-step CAN command sequences with notebook-style cells and **closed-loop** control. |
| **Plot** | Live signal plotter; receives frames over WebSocket from the bridge server. TX frames sent from Program/Encode are tagged and visible on the same timeline. |
| **Convert** | candump ↔ cansend format conversion. |

### Program page: scripted + closed-loop sequences

The Program page lets you compose a small AST of statements (Send, Wait, Repeat, Every,
Sweep, Group, Set, Bind, Read) and run it against a live CAN bus. Some highlights:

- **Notebook cells** — top-level Group blocks each get a ▶ Run button; variables persist
  across cell runs until you click *Reset vars*.
- **Variables & expressions** — `set x = 1.5`, then use `=x * 2` in any Send / Bind / Read
  field, including `nodeId` for multi-node messages.
- **Closed loop** — `Bind  pos ← Telemetry.position @=motor_idx` continuously writes the
  decoded physical value into the variable on every matching RX frame; `Read` is the
  one-shot blocking variant with a timeout. A live bindings panel shows current values
  and last-seen age.
- **Multi-block drag** — click a block, shift+click another (same parent) to select a
  range, then drag any of them to move the whole range as one unit.
- Import/Export the sequence as JSON for sharing or version control.

To enable live bus features (Plot, Program transmit/receive), download the bridge script
from any of those pages and run it on the machine with the CAN interface — see the
[Documentation](https://can-codec.lue-app.com/docs) page for the full setup walkthrough.

## Quick Start

### 1. Define your device config

Create a YAML file in `configs/` describing your CAN messages (see
`configs/example_damiao.yaml` for a full example):

```yaml
device:
  name: "Damiao Motor"
  bus: "can0"
  fd: true

messages:
  - id: 0b10000000000
    name: "MITControl"
    dlc: 8
    node_count: 7
    node_id_offset: 1
    node_id_start: 1
    description: "MIT control command (nodes 1-7)"
    signals:
      - name: "position"
        start_bit: 0
        bit_length: 16
        min: -3.141592654
        max: 3.141592654
        linear_map: true
        unit: "rad"
      - name: "velocity"
        start_bit: 16
        bit_length: 12
        min: -10.0
        max: 10.0
        linear_map: true
        unit: "rad/s"
```

### 2. Use the CLI

```bash
# List all messages from all configs
canfd-codec -c ./configs list

# Describe a message
canfd-codec -c ./configs describe MITControl

# Encode a command for node 1
canfd-codec -c ./configs encode MITControl position=1.57 velocity=2.0 kp=50.0 kd=1.0 ff=0.0 --node 1
# Output:
#   ID:   0x401
#   Node: 1
#   Data: [FF 7F 66 26 66 06 00 08]
#   DLC:  8

# Encode with cansend-compatible output
canfd-codec -c ./configs encode MITControl position=1.57 velocity=2.0 --node 1 --cansend
# Output:  can0 401##1FF7F662666060008

# Decode a received frame
canfd-codec -c ./configs decode 0x482 "00 00 00 00 32 93 54 b5"
# Output:
#   [0x482] PositionControl (node 2): Position control command (nodes 1-7)
#   target_position: 0
#   max_speed: 1.5
#   max_torque: 5

# Live monitor
canfd-codec -c ./configs monitor --bus can0

# Summary monitor (live-updating table)
canfd-codec -c ./configs monitor --bus can0 --summary
```

### 3. Use the Python API

```python
from canfd_codec.codec import Codec

codec = Codec("./configs")

# Decode motor status from node 1
decoded = codec.decode(0x681, b'\xff\x7f\x00\x08\x00\x19')
print(decoded)
for sig in decoded.signals:
    print(f"  {sig.name} = {sig.display_value()}")

# Encode MIT control for node 1
msg_id, data = codec.encode("MITControl", {
    "position": 1.57,
    "velocity": 2.0,
    "kp": 50.0,
    "kd": 1.0,
    "ff": 0.0,
}, node_id=1)
print(f"0x{msg_id:03X}: {data.hex(' ')}")
```

### 4. Generate a device-specific library (Python / C / C++ / Rust)

Need to talk to the same device from a non-Python project? `genlib` emits a
single self-contained source file with structs/classes for every message,
encode/decode methods, multi-node + broadcast helpers, and named enum/bitfield
constants. The generated code has zero runtime dependency on this package.

```bash
# Python module (Python 3.7+)
canfd-codec -c configs/example_damiao.yaml genlib --lang python -o damiao.py

# C99 header-only library
canfd-codec -c configs/example_damiao.yaml genlib --lang c      -o damiao.h

# C++17 header-only library
canfd-codec -c configs/example_damiao.yaml genlib --lang cpp    -o damiao.hpp

# Rust single-file module
canfd-codec -c configs/example_damiao.yaml genlib --lang rust   -o damiao.rs
```

Point `-c` at a directory and `-o` at a directory (trailing `/`) to emit one
file per device. Omit `-o` to print to stdout.

Usage of the generated Python lib:

```python
import damiao  # the generated file

cmd = damiao.MitControl(position=1.5, velocity=0.0, kp=10.0, kd=0.1)
can_id, payload = cmd.encode(node_id=2)        # -> (0x02, b'\x8f\x5b...')

# Decode any known frame
msg = damiao.decode_frame(can_id, payload)     # picks the right message class
print(msg.position, msg.kp)
```

Same shape in C / C++ / Rust — every generated message gets `encode`/`decode`,
`id_for_node`/`node_for_id`, plus `encode_broadcast`/`decode_broadcast` and
`broadcast_id` when the YAML defines `broadcast_node_id`.

## Config File Reference

### Signal Properties

| Field         | Required | Default          | Description                               |
|---------------|----------|------------------|-------------------------------------------|
| `name`        | yes      |                  | Signal name (used in encode/decode)        |
| `start_bit`   | yes      |                  | Bit position in the payload               |
| `bit_length`  | yes      |                  | Number of bits                            |
| `byte_order`  | no       | `little_endian`  | `little_endian` or `big_endian`           |
| `value_type`  | no       | `unsigned`       | `unsigned`, `signed`, `float32`, `float64`|
| `scale`       | no       | `1.0`            | Multiply raw by this                      |
| `offset`      | no       | `0.0`            | Add this after scaling                    |
| `min`         | no       |                  | Physical value minimum (for linear_map)   |
| `max`         | no       |                  | Physical value maximum (for linear_map)   |
| `linear_map`  | no       | `false`          | Auto-calculate scale/offset from min/max  |
| `unit`        | no       | `""`             | Display unit string                       |
| `default`     | no       |                  | Default value when encoding               |
| `constant`    | no       | `false`          | Always use default, user cannot override  |
| `enum`        | no       |                  | Map of int → string for named values      |
| `bitfield`    | no       |                  | Map of bit_position → flag_name           |

### Physical Value Formula

```
physical = raw * scale + offset
raw = (physical - offset) / scale
```

### Linear Mapping

Use `linear_map: true` to auto-calculate scale/offset from min/max:

```yaml
- name: "temperature"
  bit_length: 8
  min: -40
  max: 215
  linear_map: true
  # Auto-calculated: scale = (215 - (-40)) / 255 = 1.0, offset = -40
```

### Multi-Node Messages

For systems with multiple identical devices (e.g., 7 motors):

```yaml
messages:
  - id: 0x480             # base ID
    name: "PositionControl"
    node_count: 7
    node_id_offset: 1
    node_id_start: 1      # nodes 1-7 → IDs 0x481-0x487
```

```bash
# Encode for specific node
canfd-codec -c ./configs encode PositionControl target_position=1.5 --node 1
# => ID: 0x481
```

## MAVLink XML Support

The codec can load MAVLink XML message definition files directly. Place `.xml` files in the config directory.

The 29-bit CAN transport ID encodes both the sender and the final target node
(destination-based routing): `(1<<28) | sender_sys<<20 | sender_comp<<14 |
target_sys<<6 | target_comp`. Component IDs are limited to 0-63. `--sys-id`/`--comp-id`
set the local sender; the target is taken from the message's
`target_system`/`target_component` fields (or `--target-sys`/`--target-comp`),
with `0,0` meaning broadcast.

```bash
# Encode a MAVLink message with CAN transport format (29-bit extended ID)
canfd-codec -c ./configs/mavlink/user_define.xml encode ARM_MODE_SWITCH \
  mode=idle target_system=1 target_component=1 --mavlink --sys-id 1 --comp-id 1
# => vcan0 10104041##1FD02000000010136F2000101118A   (0x10104041 = sender 1.1 -> target 1.1)

# Array fields expand (field=[v0,v1,...] -> field_0, field_1, ...). MAVLink frames
# larger than 64 bytes are automatically split into multiple CAN FD frames.

# Decode a MAVLink v2 frame over CAN transport
canfd-codec -c ./configs/mavlink/user_define.xml \
  decode 0x10104041 "FD 02 00 00 00 01 01 36 F2 00 01 01 11 8A" --mavlink
# MAVLink: sender=1.1, target=1.1, msg_id=0xF236, seq=0
# [0x10104041] ARM_MODE_SWITCH: Switch robot arm control mode
#   target_system: 1
#   target_component: 1
#   mode: idle
```

The `--mavlink` flag enables:
- 29-bit extended CAN ID encoding/decoding with sender + target system/component IDs
- Auto-parsing of full MAVLink v2 frames (detects 0xFD magic byte)
- Automatic multi-frame splitting for large payloads (>64 bytes)

## Testing with Virtual CAN

```bash
# Set up virtual CAN interface
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan
sudo ip link set vcan0 mtu 72    # Enable CAN FD (MTU 72)
sudo ip link set up vcan0

# In terminal 1: start monitor
canfd-codec -c ./configs monitor --bus vcan0

# In terminal 2: send test frames (MITControl for node 1)
cansend vcan0 401##1FF7F662666060008
```
