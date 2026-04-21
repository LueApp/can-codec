"""
Core codec engine for CAN FD message encoding/decoding.

Handles:
  - Loading and validating YAML config files
  - Extracting signals from raw CAN data (decode)
  - Packing signals into raw CAN data (encode)
  - Physical value conversion via scale/offset
  - Enum and bitfield resolution
"""

import struct
import math
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any

import yaml


# ---------------------------------------------------------------------------
# Valid DLC sizes for CAN FD (classic CAN uses 0-8 only)
# ---------------------------------------------------------------------------
CANFD_DLC_SIZES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]


def dlc_to_bytes(dlc: int) -> int:
    """Convert a DLC value to actual byte count (handles CAN FD sizes)."""
    if dlc <= 8:
        return dlc
    mapping = {12: 12, 16: 16, 20: 20, 24: 24, 32: 32, 48: 48, 64: 64}
    return mapping.get(dlc, dlc)


# ---------------------------------------------------------------------------
# Data classes for config representation
# ---------------------------------------------------------------------------
@dataclass
class Signal:
    name: str
    start_bit: int
    bit_length: int
    byte_order: str = "little_endian"
    value_type: str = "unsigned"  # unsigned | signed | float32 | float64
    scale: float = 1.0
    offset: float = 0.0
    min_val: float | None = None
    max_val: float | None = None
    unit: str = ""
    description: str = ""
    enum_map: dict[int, str] = field(default_factory=dict)
    bitfield_map: dict[int, str] = field(default_factory=dict)
    default: Any = None  # Default value used when encoding if not provided (can be raw int, physical value, or enum string)
    constant: bool = False  # If True, this signal always uses the default value and is not user-configurable


@dataclass
class Message:
    id: int  # Base CAN ID (or fixed ID if node_count is 1)
    name: str
    direction: str = "tx"  # tx | rx
    dlc: int = 8
    description: str = ""
    node_id_offset: int = 1  # ID offset per node_id (actual_id = id + (node_id - node_id_start) * offset)
    node_count: int = 1  # Number of nodes (1 = single fixed ID, >1 = multi-node)
    node_id_start: int = 0  # First node_id (0 = 0-indexed, 1 = 1-indexed)
    signals: list[Signal] = field(default_factory=list)
    crc_extra: int | None = None  # MAVLink CRC_EXTRA seed (computed from XML definition)
    broadcast_node_id: int | None = None  # Special node_id for broadcast (e.g., 0x7F)
    mux_signal: str | None = None  # Signal whose enum value sub-groups other signals in plots
    _node_signals: dict[int, list[Signal]] = field(default_factory=dict, repr=False)

    def get_signals(self, node_id: int = 0) -> list[Signal]:
        return self._node_signals.get(node_id, self.signals)

    def get_id_for_node(self, node_id: int = 0) -> int:
        """Calculate actual CAN ID for a given node_id."""
        if self.node_count <= 1:
            return self.id
        # actual_id = base_id + node_id * offset
        return self.id + (node_id * self.node_id_offset)

    def get_node_for_id(self, can_id: int) -> int | None:
        """
        Given a CAN ID, return the node_id if it matches this message.
        Returns None if the ID doesn't match any valid node.
        For broadcast IDs, returns broadcast_node_id.
        """
        if self.node_count <= 1:
            # Single fixed ID
            return self.node_id_start if can_id == self.id else None

        # Multi-node: check if ID is in valid range
        # actual_id = base_id + node_id * offset
        # node_id = (actual_id - base_id) / offset
        offset = can_id - self.id
        if self.node_id_offset == 0:
            return self.node_id_start if offset == 0 else None
        if offset % self.node_id_offset != 0:
            return None
        node_id = offset // self.node_id_offset
        # Check broadcast address
        if self.broadcast_node_id is not None and node_id == self.broadcast_node_id:
            return self.broadcast_node_id
        max_node_id = self.node_id_start + self.node_count - 1
        if self.node_id_start <= node_id <= max_node_id:
            return node_id
        return None


@dataclass
class DeviceConfig:
    name: str
    version: str = ""
    description: str = ""
    bus: str = "vcan0"
    fd: bool = True
    mavlink: bool = False
    bitrate: int = 500000
    data_bitrate: int = 2000000
    messages: list[Message] = field(default_factory=list)
    # Lookup maps built after loading
    _by_id: dict[int, Message] = field(default_factory=dict, repr=False)
    _by_name: dict[str, Message] = field(default_factory=dict, repr=False)

    def build_lookups(self):
        self._by_id = {m.id: m for m in self.messages}
        self._by_name = {m.name: m for m in self.messages}

    def get_by_id(self, msg_id: int) -> Message | None:
        return self._by_id.get(msg_id)

    def get_by_name(self, name: str) -> Message | None:
        return self._by_name.get(name)


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------
def _resolve_params(raw: dict, params: dict) -> dict:
    """Replace $param_name strings with values from params dict."""
    resolved = dict(raw)
    for key in ('min', 'max', 'scale', 'offset'):
        val = resolved.get(key)
        if isinstance(val, str) and val.startswith('$'):
            param_name = val[1:]
            if param_name in params:
                resolved[key] = params[param_name]
            else:
                raise ValueError(f"Unknown parameter '${param_name}' in signal '{raw.get('name', '?')}'")
    return resolved


def _parse_signal(raw: dict, params: dict | None = None) -> Signal:
    """Parse a signal definition from YAML dict."""
    if params:
        raw = _resolve_params(raw, params)
    bit_length = raw["bit_length"]
    value_type = raw.get("value_type", "unsigned")

    # Determine scale and offset
    scale = raw.get("scale", 1.0)
    offset = raw.get("offset", 0.0)
    min_val = raw.get("min")
    max_val = raw.get("max")

    # If linear_map is enabled, calculate scale/offset from min/max
    # linear_map also implies big-endian (Motorola) byte order
    is_linear_map = raw.get("linear_map", False)
    if is_linear_map and min_val is not None and max_val is not None:
        # For signed types, raw range is different
        if value_type == "signed":
            max_raw = (1 << (bit_length - 1)) - 1  # e.g., 127 for 8-bit
            min_raw = -(1 << (bit_length - 1))     # e.g., -128 for 8-bit
        else:
            max_raw = (1 << bit_length) - 1  # e.g., 255 for 8-bit
            min_raw = 0

        # physical = raw * scale + offset
        # min_val = min_raw * scale + offset
        # max_val = max_raw * scale + offset
        # Solving: scale = (max_val - min_val) / (max_raw - min_raw)
        #          offset = min_val - min_raw * scale
        raw_range = max_raw - min_raw
        if raw_range != 0:
            scale = (max_val - min_val) / raw_range
            offset = min_val - min_raw * scale

    # linear_map implies big_endian byte order (Motorola style, like dm_parser.py)
    byte_order = raw.get("byte_order", "big_endian" if is_linear_map else "little_endian")

    sig = Signal(
        name=raw["name"],
        start_bit=raw["start_bit"],
        bit_length=bit_length,
        byte_order=byte_order,
        value_type=value_type,
        scale=scale,
        offset=offset,
        min_val=min_val,
        max_val=max_val,
        unit=raw.get("unit", ""),
        description=raw.get("description", ""),
        default=raw.get("default"),
        constant=raw.get("constant", False),
    )
    if "enum" in raw:
        sig.enum_map = {int(k): v for k, v in raw["enum"].items()}
    if "bitfield" in raw:
        sig.bitfield_map = {int(k): v for k, v in raw["bitfield"].items()}
    return sig


def _parse_message(raw: dict, params: dict | None = None) -> Message:
    """Parse a message definition from YAML dict."""
    msg_id = raw["id"]
    if isinstance(msg_id, str):
        msg_id = int(msg_id, 0)  # handles "0x101"

    broadcast_raw = raw.get("broadcast_node_id")
    broadcast_node_id = None
    if broadcast_raw is not None:
        broadcast_node_id = int(str(broadcast_raw), 0) if isinstance(broadcast_raw, str) else int(broadcast_raw)

    msg = Message(
        id=msg_id,
        name=raw["name"],
        direction=raw.get("direction", "tx"),
        dlc=raw.get("dlc", 8),
        description=raw.get("description", ""),
        node_id_offset=raw.get("node_id_offset", 1),
        node_count=raw.get("node_count", 1),
        node_id_start=raw.get("node_id_start", 0),
        broadcast_node_id=broadcast_node_id,
        mux_signal=raw.get("mux_signal"),
    )
    for sig_raw in raw.get("signals", []):
        msg.signals.append(_parse_signal(sig_raw, params))
    return msg


def load_config(path: str | Path) -> DeviceConfig:
    """Load a device config from a YAML file."""
    path = Path(path)
    with open(path, "r") as f:
        raw = yaml.safe_load(f)

    dev_raw = raw.get("device", {})

    config = DeviceConfig(
        name=dev_raw.get("name", path.stem),
        version=dev_raw.get("version", ""),
        description=dev_raw.get("description", ""),
        bus=dev_raw.get("bus", "vcan0"),
        fd=dev_raw.get("fd", True),
        bitrate=dev_raw.get("bitrate", 500000),
        data_bitrate=dev_raw.get("data_bitrate", 2000000),
    )

    default_params = raw.get("parameters", {})
    node_groups = raw.get("node_groups", [])

    for msg_raw in raw.get("messages", []):
        msg = _parse_message(msg_raw, default_params if default_params else None)

        for group in node_groups:
            merged = {**default_params, **group.get("parameters", {})}
            if merged != default_params:
                group_signals = [_parse_signal(s, merged) for s in msg_raw.get("signals", [])]
                for nid in group["nodes"]:
                    msg._node_signals[nid] = group_signals

        config.messages.append(msg)

    config.build_lookups()
    return config


def load_all_configs(config_dir: str | Path) -> list[DeviceConfig]:
    """Load all .yaml config files from a directory."""
    config_dir = Path(config_dir)
    configs = []
    for p in sorted(config_dir.glob("*.yaml")):
        configs.append(load_config(p))
    for p in sorted(config_dir.glob("*.yml")):
        configs.append(load_config(p))
    return configs


# ---------------------------------------------------------------------------
# Bit-level extraction & packing (little-endian signal layout)
# ---------------------------------------------------------------------------
def _extract_bits_le(data: bytes, start_bit: int, bit_length: int) -> int:
    """Extract a little-endian signal from the data payload."""
    value = 0
    for i in range(bit_length):
        byte_idx = (start_bit + i) // 8
        bit_idx = (start_bit + i) % 8
        if byte_idx < len(data):
            if data[byte_idx] & (1 << bit_idx):
                value |= (1 << i)
    return value


def _extract_bits_be(data: bytes, start_bit: int, bit_length: int) -> int:
    """
    Extract a big-endian signal from the data payload.

    Uses continuous MSB-first bit ordering (like dm_parser.py):
    - Bit 0 is byte 0 bit 7 (MSB of first byte)
    - Bit 7 is byte 0 bit 0 (LSB of first byte)
    - Bit 8 is byte 1 bit 7 (MSB of second byte)
    - etc.

    start_bit is the bit position of the MSB of the signal.
    """
    value = 0
    for i in range(bit_length):
        bit_pos = start_bit + i
        byte_idx = bit_pos // 8
        bit_in_byte = 7 - (bit_pos % 8)  # MSB-first within byte
        if byte_idx < len(data):
            if data[byte_idx] & (1 << bit_in_byte):
                value |= (1 << (bit_length - 1 - i))
    return value


def _pack_bits_le(data: bytearray, start_bit: int, bit_length: int, value: int):
    """Pack a value into the data payload as a little-endian signal."""
    for i in range(bit_length):
        byte_idx = (start_bit + i) // 8
        bit_idx = (start_bit + i) % 8
        while byte_idx >= len(data):
            data.append(0)
        if value & (1 << i):
            data[byte_idx] |= (1 << bit_idx)
        else:
            data[byte_idx] &= ~(1 << bit_idx)


def _pack_bits_be(data: bytearray, start_bit: int, bit_length: int, value: int):
    """
    Pack a value into the data payload as a big-endian signal.

    Uses continuous MSB-first bit ordering (like dm_parser.py):
    - Bit 0 is byte 0 bit 7 (MSB of first byte)
    - Bit 7 is byte 0 bit 0 (LSB of first byte)
    - Bit 8 is byte 1 bit 7 (MSB of second byte)
    - etc.

    start_bit is the bit position of the MSB of the signal.
    """
    for i in range(bit_length):
        bit_pos = start_bit + i
        byte_idx = bit_pos // 8
        bit_in_byte = 7 - (bit_pos % 8)  # MSB-first within byte
        while byte_idx >= len(data):
            data.append(0)
        if value & (1 << (bit_length - 1 - i)):
            data[byte_idx] |= (1 << bit_in_byte)
        else:
            data[byte_idx] &= ~(1 << bit_in_byte)


# ---------------------------------------------------------------------------
# Signal-level decode / encode
# ---------------------------------------------------------------------------
def _raw_to_physical(raw_value: int, signal: Signal) -> Any:
    """Convert raw integer to physical value using type, scale, offset."""
    vtype = signal.value_type

    if vtype == "float32":
        # Interpret 32-bit raw as IEEE 754 float
        raw_bytes = struct.pack("<I", raw_value & 0xFFFFFFFF)
        return struct.unpack("<f", raw_bytes)[0]

    elif vtype == "float64":
        raw_bytes = struct.pack("<Q", raw_value & 0xFFFFFFFFFFFFFFFF)
        return struct.unpack("<d", raw_bytes)[0]

    elif vtype == "signed":
        # Two's complement
        if raw_value >= (1 << (signal.bit_length - 1)):
            raw_value -= (1 << signal.bit_length)
        return raw_value * signal.scale + signal.offset

    else:  # unsigned
        return raw_value * signal.scale + signal.offset


def _physical_to_raw(physical_value: float, signal: Signal) -> int:
    """Convert physical value back to raw integer."""
    vtype = signal.value_type

    if vtype == "float32":
        raw_bytes = struct.pack("<f", physical_value)
        return struct.unpack("<I", raw_bytes)[0]

    elif vtype == "float64":
        raw_bytes = struct.pack("<d", physical_value)
        return struct.unpack("<Q", raw_bytes)[0]

    else:
        # Use int() truncation (not round()) to match dm_parser.py behavior
        raw = int((physical_value - signal.offset) / signal.scale)
        if vtype == "signed" and raw < 0:
            raw += (1 << signal.bit_length)
        # Clamp to valid range
        max_raw = (1 << signal.bit_length) - 1
        raw = max(0, min(raw, max_raw))
        return raw


def _resolve_enum(raw_int: int, signal: Signal) -> str | None:
    """Look up the enum name for a raw value, or None."""
    if signal.enum_map:
        return signal.enum_map.get(int(round(raw_int)))
    return None


def _reverse_enum(name: str, signal: Signal) -> int | None:
    """Look up the raw value for an enum name, or None."""
    if signal.enum_map:
        for k, v in signal.enum_map.items():
            if v.lower() == name.lower():
                return k
    return None


def _resolve_bitfield(raw_int: int, signal: Signal) -> dict[str, bool]:
    """Decode bitfield flags from a raw value."""
    result = {}
    for bit, name in signal.bitfield_map.items():
        result[name] = bool(raw_int & (1 << bit))
    return result


def _compose_bitfield(flags: dict[str, bool], signal: Signal) -> int:
    """Encode bitfield flags into a raw value."""
    value = 0
    reverse_map = {v.lower(): k for k, v in signal.bitfield_map.items()}
    for name, active in flags.items():
        bit = reverse_map.get(name.lower())
        if bit is not None and active:
            value |= (1 << bit)
    return value


# ---------------------------------------------------------------------------
# Public API: decode / encode
# ---------------------------------------------------------------------------
@dataclass
class DecodedSignal:
    name: str
    raw_value: int
    physical_value: Any
    enum_name: str | None = None
    bitfield_flags: dict[str, bool] | None = None
    unit: str = ""
    description: str = ""

    def display_value(self) -> str:
        """Human-friendly display string."""
        if self.bitfield_flags is not None:
            active = [n for n, v in self.bitfield_flags.items() if v]
            return ", ".join(active) if active else "(none)"
        if self.enum_name is not None:
            return self.enum_name
        if isinstance(self.physical_value, float):
            # Clean up floating point display
            if self.physical_value == int(self.physical_value):
                val_str = str(int(self.physical_value))
            else:
                val_str = f"{self.physical_value:.4g}"
        else:
            val_str = str(self.physical_value)
        if self.unit:
            return f"{val_str} {self.unit}"
        return val_str


@dataclass
class DecodedMessage:
    msg_id: int  # Actual CAN ID received
    name: str
    description: str
    signals: list[DecodedSignal]
    raw_data: bytes
    node_id: int = 0  # Node ID (0 for single-node messages)
    base_id: int | None = None  # Base ID from config (for multi-node)
    is_broadcast: bool = False
    sub_messages: list["DecodedMessage"] | None = None  # Per-node messages for broadcast

    def to_dict(self) -> dict:
        """Return a flat dict of signal_name -> display_value."""
        if self.is_broadcast and self.sub_messages:
            result: dict = {}
            for sub in self.sub_messages:
                node_key = f"node_{sub.node_id}"
                result[node_key] = {s.name: s.display_value() for s in sub.signals}
            return result
        result = {s.name: s.display_value() for s in self.signals}
        if self.node_id != 0:
            result["_node_id"] = self.node_id
        return result

    def __str__(self) -> str:
        if self.is_broadcast and self.sub_messages:
            lines = [f"[0x{self.msg_id:03X}] {self.name} (broadcast, {len(self.sub_messages)} nodes): {self.description}"]
            for sub in self.sub_messages:
                sig_parts = [f"{s.name}={s.display_value()}" for s in sub.signals]
                lines.append(f"  Node {sub.node_id}: {', '.join(sig_parts)}")
            return "\n".join(lines)
        if self.node_id != 0:
            lines = [f"[0x{self.msg_id:03X}] {self.name} (node {self.node_id}): {self.description}"]
        else:
            lines = [f"[0x{self.msg_id:03X}] {self.name}: {self.description}"]
        for s in self.signals:
            lines.append(f"  {s.name}: {s.display_value()}")
        return "\n".join(lines)


def decode(msg_def: Message, data: bytes, actual_id: int | None = None, node_id: int = 0) -> DecodedMessage:
    """
    Decode raw CAN data bytes into a DecodedMessage.

    Args:
        msg_def: Message definition from config
        data: Raw CAN data bytes
        actual_id: Actual CAN ID received (for multi-node, may differ from base)
        node_id: Node ID (0 for single-node messages)
    """
    decoded_signals = []

    for sig in msg_def.get_signals(node_id):
        # Extract raw bits
        if sig.byte_order == "big_endian":
            raw = _extract_bits_be(data, sig.start_bit, sig.bit_length)
        else:
            raw = _extract_bits_le(data, sig.start_bit, sig.bit_length)

        # Convert to physical
        physical = _raw_to_physical(raw, sig)

        # Resolve enum / bitfield
        enum_name = _resolve_enum(raw, sig) if sig.enum_map else None
        bitfield = _resolve_bitfield(raw, sig) if sig.bitfield_map else None

        decoded_signals.append(DecodedSignal(
            name=sig.name,
            raw_value=raw,
            physical_value=physical,
            enum_name=enum_name,
            bitfield_flags=bitfield,
            unit=sig.unit,
            description=sig.description,
        ))

    return DecodedMessage(
        msg_id=actual_id if actual_id is not None else msg_def.id,
        name=msg_def.name,
        description=msg_def.description,
        signals=decoded_signals,
        raw_data=data,
        node_id=node_id,
        base_id=msg_def.id if node_id != 0 else None,
    )


def encode(msg_def: Message, values: dict[str, Any], node_id: int = 0) -> bytes:
    """
    Encode a dict of signal values into raw CAN data bytes.

    `values` maps signal_name -> value, where value can be:
      - A number (physical value, will be converted through scale/offset)
      - A string (looked up in enum)
      - A dict of {flag_name: bool} (for bitfield signals)

    Signals with `constant: true` always use their default value.
    Signals with a `default` value use it when not provided in `values`.
    """
    byte_count = dlc_to_bytes(msg_def.dlc)
    data = bytearray(byte_count)

    for sig in msg_def.get_signals(node_id):
        # Determine the value to use for this signal
        if sig.constant:
            # Constant signals always use their default value
            if sig.default is None:
                continue  # No default defined for constant - skip
            val = sig.default
        elif sig.name in values:
            # User-provided value
            val = values[sig.name]
        elif sig.default is not None:
            # Use default if available
            val = sig.default
        else:
            # No value provided and no default - skip
            continue

        # Determine raw value
        if sig.bitfield_map and isinstance(val, dict):
            raw = _compose_bitfield(val, sig)
        elif sig.enum_map and isinstance(val, str):
            raw = _reverse_enum(val, sig)
            if raw is None:
                raise ValueError(
                    f"Unknown enum value '{val}' for signal '{sig.name}'. "
                    f"Valid values: {list(sig.enum_map.values())}"
                )
        else:
            raw = _physical_to_raw(float(val), sig)

        # Pack into data
        if sig.byte_order == "big_endian":
            _pack_bits_be(data, sig.start_bit, sig.bit_length, raw)
        else:
            _pack_bits_le(data, sig.start_bit, sig.bit_length, raw)

    return bytes(data)


def encode_broadcast(msg_def: Message, per_node_values: dict[int, dict[str, Any]]) -> bytes:
    """
    Encode a broadcast frame by concatenating per-node payloads.

    Args:
        msg_def: Message definition (must have broadcast_node_id set)
        per_node_values: dict mapping node_id -> signal values dict

    Returns:
        Concatenated payload bytes (node_count * single_node_bytes)
    """
    segments = []
    for nid in range(msg_def.node_id_start, msg_def.node_id_start + msg_def.node_count):
        values = per_node_values.get(nid, {})
        segments.append(encode(msg_def, values, node_id=nid))
    return b"".join(segments)


def decode_broadcast(msg_def: Message, data: bytes, actual_id: int) -> DecodedMessage:
    """
    Decode a broadcast frame by splitting into per-node segments.

    Args:
        msg_def: Message definition
        data: Full broadcast payload (node_count * single_node_bytes)
        actual_id: The broadcast CAN ID

    Returns:
        DecodedMessage with is_broadcast=True and sub_messages populated.
    """
    byte_count = dlc_to_bytes(msg_def.dlc)
    sub_messages = []
    for i in range(msg_def.node_count):
        node_id = msg_def.node_id_start + i
        segment = data[i * byte_count: (i + 1) * byte_count]
        # Pad if segment is shorter than expected
        if len(segment) < byte_count:
            segment = segment + b"\x00" * (byte_count - len(segment))
        sub = decode(msg_def, segment, actual_id=msg_def.get_id_for_node(node_id), node_id=node_id)
        sub_messages.append(sub)

    return DecodedMessage(
        msg_id=actual_id,
        name=msg_def.name,
        description=msg_def.description,
        signals=[],
        raw_data=data,
        node_id=msg_def.broadcast_node_id or 0,
        base_id=msg_def.id,
        is_broadcast=True,
        sub_messages=sub_messages,
    )


# ---------------------------------------------------------------------------
# Multi-device codec manager
# ---------------------------------------------------------------------------
class Codec:
    """
    Manages multiple device configs and provides unified decode/encode.

    Usage:
        codec = Codec("./configs")
        decoded = codec.decode(0x201, b'\\x00\\x01...')
        raw = codec.encode("SetSpeed", {"target_speed": 1500, "direction": "forward"})

        # Multi-node support (e.g., motor 2 at base_id + 2)
        can_id, raw = codec.encode("SetSpeed", {"target_speed": 1500}, node_id=2)
    """

    def __init__(self, config_path: str | Path | None = None):
        self.devices: list[DeviceConfig] = []
        self._by_id: dict[int, tuple[DeviceConfig, Message]] = {}
        self._by_mavlink_id: dict[int, tuple[DeviceConfig, Message]] = {}
        self._by_name: dict[str, tuple[DeviceConfig, Message]] = {}
        self._multi_node_messages: list[tuple[DeviceConfig, Message]] = []

        if config_path is not None:
            p = Path(config_path)
            if p.is_dir():
                self.load_directory(p)
            else:
                self.load_file(p)

    def load_file(self, path: str | Path):
        """Load a single config file (YAML or MAVLink XML)."""
        path = Path(path)
        if path.suffix == ".xml":
            from .mavlink_loader import load_mavlink_xml
            config = load_mavlink_xml(path)
        else:
            config = load_config(path)
        self.devices.append(config)
        self._rebuild_lookups()

    def load_directory(self, path: str | Path):
        """Load all config files from a directory (YAML and MAVLink XML)."""
        path = Path(path)

        # Load YAML configs
        for config in load_all_configs(path):
            self.devices.append(config)

        # Load MAVLink XML configs
        for xml_file in sorted(path.glob("*.xml")):
            try:
                from .mavlink_loader import load_mavlink_xml
                config = load_mavlink_xml(xml_file)
                self.devices.append(config)
            except Exception as e:
                # Skip invalid XML files
                pass

        self._rebuild_lookups()

    def _rebuild_lookups(self):
        self._by_id.clear()
        self._by_mavlink_id.clear()
        self._by_name.clear()
        self._multi_node_messages.clear()
        for dev in self.devices:
            id_map = self._by_mavlink_id if dev.mavlink else self._by_id
            for msg in dev.messages:
                if msg.node_count > 1:
                    self._multi_node_messages.append((dev, msg))
                if msg.id not in id_map:
                    id_map[msg.id] = (dev, msg)
                if msg.name not in self._by_name:
                    self._by_name[msg.name] = (dev, msg)

    def _find_message_by_id(self, msg_id: int, dlc: int | None = None) -> tuple[DeviceConfig, Message, int] | None:
        """
        Find message definition for a CAN ID.
        When dlc is provided, prefers messages whose DLC matches the frame length.
        Returns (device, message, node_id) or None.
        """
        # First try exact match
        entry = self._by_id.get(msg_id)
        if entry is not None:
            return (entry[0], entry[1], 0)

        # Try multi-node range matching — collect all candidates
        candidates = []
        for dev, msg in self._multi_node_messages:
            node_id = msg.get_node_for_id(msg_id)
            if node_id is not None:
                candidates.append((dev, msg, node_id))

        if not candidates:
            return None

        # Prefer matching DLC when available
        if dlc is not None:
            for c in candidates:
                if c[1].dlc == dlc:
                    return c

        return candidates[0]

    def find_mavlink_message(self, msg_id: int) -> tuple[DeviceConfig, Message] | None:
        """Look up a MAVLink message by its MAVLink message ID."""
        return self._by_mavlink_id.get(msg_id)

    def decode(self, msg_id: int, data: bytes) -> DecodedMessage | None:
        """Decode a CAN frame by ID. Returns None if ID is unknown."""
        result = self._find_message_by_id(msg_id, dlc=len(data))
        if result is None:
            return None
        _, msg_def, node_id = result
        # Broadcast frame detection
        if msg_def.broadcast_node_id is not None and node_id == msg_def.broadcast_node_id:
            return decode_broadcast(msg_def, data, actual_id=msg_id)
        # Pad data to expected DLC if shorter (e.g. MAVLink v2 zero-trimmed payloads)
        if len(data) < msg_def.dlc:
            data = data + b"\x00" * (msg_def.dlc - len(data))
        return decode(msg_def, data, actual_id=msg_id, node_id=node_id)

    def encode(self, msg_name: str, values: dict[str, Any], node_id: int = 0,
               broadcast: bool = False) -> tuple[int, bytes]:
        """
        Encode a message by name. Returns (can_id, data_bytes).

        Args:
            msg_name: Message name from config
            values: Dict of signal_name -> value. For broadcast mode, values
                    that are lists are distributed per-node; scalars are shared.
            node_id: Node ID for multi-node messages (default 0, ignored if broadcast)
            broadcast: If True, encode a broadcast frame (all nodes concatenated)

        Raises KeyError if message name is unknown.
        """
        entry = self._by_name.get(msg_name)
        if entry is None:
            raise KeyError(
                f"Unknown message '{msg_name}'. "
                f"Available: {sorted(self._by_name.keys())}"
            )
        _, msg_def = entry

        if broadcast:
            if msg_def.broadcast_node_id is None:
                raise ValueError(f"Message '{msg_name}' does not support broadcast mode")
            # Build per-node values from mixed scalar/list input
            per_node: dict[int, dict[str, Any]] = {}
            for i in range(msg_def.node_count):
                nid = msg_def.node_id_start + i
                node_vals: dict[str, Any] = {}
                for k, v in values.items():
                    if isinstance(v, list):
                        if i < len(v):
                            node_vals[k] = v[i]
                    else:
                        node_vals[k] = v
                per_node[nid] = node_vals
            data = encode_broadcast(msg_def, per_node)
            actual_id = msg_def.get_id_for_node(msg_def.broadcast_node_id)
            return actual_id, data

        data = encode(msg_def, values, node_id=node_id)
        actual_id = msg_def.get_id_for_node(node_id)
        return actual_id, data

    def list_messages(self) -> list[dict]:
        """List all known messages with basic info."""
        result = []
        for dev in self.devices:
            for msg in dev.messages:
                info = {
                    "device": dev.name,
                    "id": f"0x{msg.id:03X}",
                    "name": msg.name,
                    "direction": msg.direction,
                    "dlc": msg.dlc,
                    "fd": dev.fd,  # FD mode is a device-level setting
                    "signals": [s.name for s in msg.signals],
                    "description": msg.description,
                }
                if msg.node_count > 1:
                    info["node_count"] = msg.node_count
                    info["node_id_offset"] = msg.node_id_offset
                    info["node_id_start"] = msg.node_id_start
                    max_node_id = msg.node_id_start + msg.node_count - 1
                    max_id = msg.get_id_for_node(max_node_id)
                    info["id_range"] = f"0x{msg.id:03X}-0x{max_id:03X}"
                    info["node_range"] = f"{msg.node_id_start}-{max_node_id}"
                    if msg.broadcast_node_id is not None:
                        bcast_id = msg.get_id_for_node(msg.broadcast_node_id)
                        info["broadcast_id"] = f"0x{bcast_id:03X}"
                result.append(info)
        return result

    def describe_message(self, name: str) -> str:
        """Get a detailed description of a message and its signals."""
        entry = self._by_name.get(name)
        if entry is None:
            return f"Unknown message: {name}"
        dev, msg = entry
        lines = [
            f"Message: {msg.name} (0x{msg.id:03X})",
            f"Device:  {dev.name} ({'CAN FD' if dev.fd else 'Classic CAN'})",
            f"Dir:     {msg.direction}",
            f"DLC:     {msg.dlc}",
        ]
        if msg.node_count > 1:
            max_node_id = msg.node_id_start + msg.node_count - 1
            max_id = msg.get_id_for_node(max_node_id)
            lines.append(f"Nodes:   {msg.node_id_start}-{max_node_id} (IDs 0x{msg.id:03X}-0x{max_id:03X}, offset {msg.node_id_offset})")
            if msg.broadcast_node_id is not None:
                bcast_id = msg.get_id_for_node(msg.broadcast_node_id)
                bcast_dlc = dlc_to_bytes(msg.dlc) * msg.node_count
                lines.append(f"Bcast:   0x{bcast_id:03X} (node_id=0x{msg.broadcast_node_id:02X}, {bcast_dlc} bytes)")
        lines.extend([
            f"Desc:    {msg.description}",
            "",
            "Signals:",
        ])
        for sig in msg.signals:
            parts = [f"  {sig.name}:"]
            parts.append(f"bits [{sig.start_bit}:{sig.start_bit + sig.bit_length - 1}]")
            parts.append(f"({sig.value_type})")
            if sig.scale != 1.0 or sig.offset != 0.0:
                parts.append(f"scale={sig.scale} offset={sig.offset}")
            if sig.unit:
                parts.append(f"[{sig.unit}]")
            if sig.enum_map:
                parts.append(f"enum={sig.enum_map}")
            if sig.bitfield_map:
                parts.append(f"bitfield={sig.bitfield_map}")
            if sig.constant:
                parts.append(f"CONSTANT={sig.default}")
            elif sig.default is not None:
                parts.append(f"default={sig.default}")
            lines.append(" ".join(parts))
            if sig.description:
                lines.append(f"    {sig.description}")
        if msg._node_signals:
            lines.append("")
            lines.append("Node group overrides:")
            seen_groups: dict[int, list[int]] = {}
            for nid, sigs in sorted(msg._node_signals.items()):
                sig_id = id(sigs)
                seen_groups.setdefault(sig_id, []).append(nid)
            for sig_id, nids in seen_groups.items():
                sigs = msg._node_signals[nids[0]]
                lines.append(f"  Nodes {nids}:")
                for sig, default_sig in zip(sigs, msg.signals):
                    diffs = []
                    if sig.min_val != default_sig.min_val:
                        diffs.append(f"min={sig.min_val}")
                    if sig.max_val != default_sig.max_val:
                        diffs.append(f"max={sig.max_val}")
                    if sig.scale != default_sig.scale:
                        diffs.append(f"scale={sig.scale}")
                    if sig.offset != default_sig.offset:
                        diffs.append(f"offset={sig.offset}")
                    if diffs:
                        lines.append(f"    {sig.name}: {', '.join(diffs)}")
        return "\n".join(lines)
