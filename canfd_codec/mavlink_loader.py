"""
MAVLink XML message definition loader.

Parses MAVLink XML files directly (no pymavlink dependency) and creates
Signal/Message/DeviceConfig objects compatible with the codec engine.

Handles:
  - MAVLink wire ordering (fields sorted by type size, largest first)
  - CRC_EXTRA computation for MAVLink v2 frame validation
  - <include> directive resolution for shared enums
  - MAVLink v2 frame building and parsing
"""

import re
import struct
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .codec import Signal, Message, DeviceConfig


# MAVLink type -> (bit_length, codec_value_type, wire_size_bytes)
# wire_size_bytes is used for field reordering (largest first)
MAVLINK_TYPES = {
    "uint8_t":  (8,  "unsigned", 1),
    "int8_t":   (8,  "signed",   1),
    "uint16_t": (16, "unsigned", 2),
    "int16_t":  (16, "signed",   2),
    "uint32_t": (32, "unsigned", 4),
    "int32_t":  (32, "signed",   4),
    "uint64_t": (64, "unsigned", 8),
    "int64_t":  (64, "signed",   8),
    "float":    (32, "float32",  4),
    "double":   (64, "float64",  8),
    "char":     (8,  "unsigned", 1),
}

MAVLINK_TYPE_ALIASES = {
    # MAVLink generator magic type: wire-compatible with uint8_t, always 3.
    "uint8_t_mavlink_version": "uint8_t",
}


def _parse_type(type_str: str) -> tuple[str, int, str, int, int]:
    """Parse a MAVLink type string.

    Returns: (base_type, bit_length, value_type, array_count, wire_size)
    """
    array_match = re.match(r"(\w+)\[(\d+)\]", type_str)
    if array_match:
        base_type = array_match.group(1)
        array_count = int(array_match.group(2))
    else:
        base_type = type_str
        array_count = 1

    base_type = MAVLINK_TYPE_ALIASES.get(base_type, base_type)
    if base_type not in MAVLINK_TYPES:
        raise ValueError(f"Unknown MAVLink type: {base_type}")

    bit_length, value_type, wire_size = MAVLINK_TYPES[base_type]
    return base_type, bit_length, value_type, array_count, wire_size


# ---------------------------------------------------------------------------
# MAVLink X.25 CRC
# ---------------------------------------------------------------------------
def mavlink_crc(data: bytes, seed: int = 0xFFFF) -> int:
    """Calculate MAVLink X.25 CRC checksum."""
    crc = seed
    for byte in data:
        tmp = byte ^ (crc & 0xFF)
        tmp = (tmp ^ (tmp << 4)) & 0xFF
        crc = (crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)
    return crc & 0xFFFF


def _compute_crc_extra(msg_name: str, wire_fields: list[dict]) -> int:
    """Compute MAVLink CRC_EXTRA from message definition.

    Fields must be in wire order (sorted by type size, largest first).
    Each field dict has: name, base_type, array_count.

    Algorithm (per pymavlink): CRC over msg_name + ' ', then for each field:
    type + ' ' + name + ' ', plus array_count as raw byte if array.
    Result: (crc & 0xFF) ^ (crc >> 8).
    """
    crc = 0xFFFF
    crc = mavlink_crc((msg_name + " ").encode("ascii"), crc)
    for f in wire_fields:
        crc = mavlink_crc((f["base_type"] + " ").encode("ascii"), crc)
        crc = mavlink_crc((f["name"] + " ").encode("ascii"), crc)
        if f["array_count"] > 1:
            crc = mavlink_crc(bytes([f["array_count"]]), crc)
    return (crc & 0xFF) ^ (crc >> 8)


# ---------------------------------------------------------------------------
# XML parsing
# ---------------------------------------------------------------------------
def _parse_enums(root: ET.Element) -> dict[str, dict[int, str]]:
    enums = {}
    enums_elem = root.find("enums")
    if enums_elem is None:
        return enums

    for enum_elem in enums_elem.findall("enum"):
        enum_name = enum_elem.get("name")
        if not enum_name:
            continue

        values = {}
        for entry in enum_elem.findall("entry"):
            value = entry.get("value")
            name = entry.get("name")
            if value is not None and name:
                short_name = name
                if short_name.startswith(enum_name + "_"):
                    short_name = short_name[len(enum_name) + 1:]
                try:
                    raw_value = int(value, 0)
                except ValueError:
                    raw_value = int(value, 10)
                values[raw_value] = short_name.lower()

        enums[enum_name] = values

    return enums


def _load_xml_with_includes(path: Path) -> tuple[ET.Element, dict[str, dict[int, str]]]:
    """Load a MAVLink XML file and resolve <include> directives for enums."""
    tree = ET.parse(path)
    root = tree.getroot()

    enums = {}

    # Resolve includes first (for shared enums)
    include_elem = root.find("include")
    if include_elem is not None and include_elem.text:
        include_path = path.parent / include_elem.text.strip()
        if include_path.exists():
            _, included_enums = _load_xml_with_includes(include_path)
            enums.update(included_enums)

    # Parse enums from this file (override included ones)
    enums.update(_parse_enums(root))

    return root, enums


def _parse_messages(root: ET.Element, enums: dict[str, dict[int, str]]) -> list[Message]:
    messages = []
    messages_elem = root.find("messages")
    if messages_elem is None:
        return messages

    for msg_elem in messages_elem.findall("message"):
        msg_id = msg_elem.get("id")
        msg_name = msg_elem.get("name")
        if not msg_id or not msg_name:
            continue

        msg_id = int(msg_id)
        description = ""
        desc_elem = msg_elem.find("description")
        if desc_elem is not None and desc_elem.text:
            description = desc_elem.text.strip()

        # First pass: collect raw fields in XML order, tracking the
        # <extensions/> boundary. Fields before it are "core" (sorted by
        # type size for wire alignment, included in CRC_EXTRA). Fields
        # after it are "extensions" (kept in declaration order, excluded
        # from CRC_EXTRA — see MAVLink2 spec).
        core_fields = []
        ext_fields = []
        in_extensions = False
        for child in msg_elem:
            if child.tag == "extensions":
                in_extensions = True
                continue
            if child.tag != "field":
                continue

            field_type = child.get("type")
            field_name = child.get("name")
            field_enum = child.get("enum")
            field_desc = child.text.strip() if child.text else ""

            if not field_type or not field_name:
                continue

            is_mavlink_version = field_type == "uint8_t_mavlink_version"

            try:
                base_type, bit_length, value_type, array_count, wire_size = _parse_type(field_type)
            except ValueError:
                continue

            enum_map = {}
            if field_enum and field_enum in enums:
                enum_map = enums[field_enum]

            field_info = {
                "name": field_name,
                "type_str": field_type,
                "base_type": base_type,
                "bit_length": bit_length,
                "value_type": value_type,
                "array_count": array_count,
                "wire_size": wire_size,
                "enum_map": enum_map,
                "description": field_desc,
                "default": 3 if is_mavlink_version else None,
                "constant": is_mavlink_version,
            }
            (ext_fields if in_extensions else core_fields).append(field_info)

        # Core fields: stable sort by wire size, largest first.
        # Extension fields: declaration order, appended after core.
        sorted_core = sorted(core_fields, key=lambda f: f["wire_size"], reverse=True)
        wire_fields = sorted_core + ext_fields

        # CRC_EXTRA is computed over core fields only (extensions excluded).
        crc_extra = _compute_crc_extra(msg_name, sorted_core)

        # Second pass: create Signal objects with wire-ordered bit offsets
        signals = []
        bit_offset = 0
        for f in wire_fields:
            if f["array_count"] > 1:
                for i in range(f["array_count"]):
                    sig = Signal(
                        name=f"{f['name']}_{i}",
                        start_bit=bit_offset,
                        bit_length=f["bit_length"],
                        byte_order="little_endian",
                        value_type=f["value_type"],
                        description=f"{f['description']} [index {i}]" if f["description"] else f"[index {i}]",
                        enum_map=f["enum_map"].copy() if f["enum_map"] else {},
                        default=f["default"],
                        constant=f["constant"],
                    )
                    signals.append(sig)
                    bit_offset += f["bit_length"]
            else:
                sig = Signal(
                    name=f["name"],
                    start_bit=bit_offset,
                    bit_length=f["bit_length"],
                    byte_order="little_endian",
                    value_type=f["value_type"],
                    description=f["description"],
                    enum_map=f["enum_map"],
                    default=f["default"],
                    constant=f["constant"],
                )
                signals.append(sig)
                bit_offset += f["bit_length"]

        dlc = (bit_offset + 7) // 8

        msg = Message(
            id=msg_id,
            name=msg_name,
            direction="tx",
            dlc=dlc,
            description=description,
            signals=signals,
            crc_extra=crc_extra,
        )
        messages.append(msg)

    return messages


def load_mavlink_xml(path: str | Path) -> DeviceConfig:
    """Load a MAVLink XML file into a DeviceConfig."""
    path = Path(path)
    root, enums = _load_xml_with_includes(path)
    messages = _parse_messages(root, enums)

    version = ""
    version_elem = root.find("version")
    if version_elem is not None and version_elem.text:
        version = version_elem.text.strip()

    config = DeviceConfig(
        name=path.stem,
        version=f"MAVLink v{version}" if version else "MAVLink",
        description=f"MAVLink messages from {path.name}",
        fd=True,
        mavlink=True,
        messages=messages,
    )
    config.build_lookups()

    return config


# ---------------------------------------------------------------------------
# CAN transport: 29-bit extended ID layout (destination-based routing)
# ---------------------------------------------------------------------------
# Mirrors mavlink_bridge/impl/mavlink_can_transport.h. The extended CAN ID
# encodes BOTH the sender and the final target MAVLink node:
#
#   bit  28      : MAVLink header flag (1 for MAVLink-over-CAN frames)
#   bits 20-27   : sender_sys   (8 bit, 0-255)
#   bits 14-19   : sender_comp  (6 bit, 0-63)
#   bits  6-13   : target_sys   (8 bit, 0-255)
#   bits  0- 5   : target_comp  (6 bit, 0-63)
#
# Broadcast = target_sys == 0 and target_comp == 0.
# NOTE: component IDs are limited to 0-63 by the 6-bit fields.
CAN_MAVLINK_HEADER = 0x1 << 28          # 0x10000000
CAN_MAVLINK_TARGET_MASK = 0x10003FFF    # HEADER + target_sys + target_comp
CAN_MAVLINK_BROADCAST_ID = CAN_MAVLINK_HEADER


def mavlink_can_make_id(sender_sys: int, sender_comp: int,
                        target_sys: int, target_comp: int) -> int:
    """Build a 29-bit MAVLink CAN transport ID (without CAN_EFF_FLAG)."""
    return (CAN_MAVLINK_HEADER
            | ((sender_sys & 0xFF) << 20)
            | ((sender_comp & 0x3F) << 14)
            | ((target_sys & 0xFF) << 6)
            | (target_comp & 0x3F))


def mavlink_can_is_mavlink(can_id: int) -> bool:
    """True if the CAN ID carries the MAVLink header flag (bit 28)."""
    return bool(can_id & CAN_MAVLINK_HEADER)


def mavlink_can_id_sender_sys(can_id: int) -> int:
    return (can_id >> 20) & 0xFF


def mavlink_can_id_sender_comp(can_id: int) -> int:
    return (can_id >> 14) & 0x3F


def mavlink_can_id_target_sys(can_id: int) -> int:
    return (can_id >> 6) & 0xFF


def mavlink_can_id_target_comp(can_id: int) -> int:
    return can_id & 0x3F


# ---------------------------------------------------------------------------
# MAVLink v2 frame building / parsing (no pymavlink dependency)
# ---------------------------------------------------------------------------
def build_mavlink_v2_frame(
    msg_id: int,
    payload: bytes,
    crc_extra: int,
    sys_id: int = 1,
    comp_id: int = 1,
    seq: int = 0,
) -> bytes:
    """Build a complete MAVLink v2 frame.

    Returns the full frame: header(10) + payload + crc(2).
    Trailing zero bytes in payload are trimmed per MAVLink v2 spec.
    """
    # Trim trailing zeros from payload (MAVLink v2 zero-trimming)
    trimmed = payload.rstrip(b"\x00")
    if not trimmed:
        trimmed = b"\x00"  # at least 1 byte

    frame = bytearray()
    frame.append(0xFD)  # MAVLink v2 magic
    frame.append(len(trimmed))
    frame.append(0x00)  # incompat_flags
    frame.append(0x00)  # compat_flags
    frame.append(seq & 0xFF)
    frame.append(sys_id & 0xFF)
    frame.append(comp_id & 0xFF)
    frame.append(msg_id & 0xFF)
    frame.append((msg_id >> 8) & 0xFF)
    frame.append((msg_id >> 16) & 0xFF)
    frame.extend(trimmed)

    # CRC over bytes 1..end, then accumulate CRC_EXTRA
    crc = mavlink_crc(frame[1:])
    crc = mavlink_crc(bytes([crc_extra]), crc)
    frame.append(crc & 0xFF)
    frame.append((crc >> 8) & 0xFF)

    return bytes(frame)


def parse_mavlink_v2_header(data: bytes) -> dict[str, Any] | None:
    """Parse a MAVLink v2 frame header.

    Returns dict with: payload_len, seq, sys_id, comp_id, msg_id, payload, full_frame
    or None if not a valid MAVLink v2 frame.
    """
    if len(data) < 12 or data[0] != 0xFD:
        return None

    payload_len = data[1]
    if len(data) < 12 + payload_len:
        return None

    return {
        "payload_len": payload_len,
        "incompat_flags": data[2],
        "compat_flags": data[3],
        "seq": data[4],
        "sys_id": data[5],
        "comp_id": data[6],
        "msg_id": data[7] | (data[8] << 8) | (data[9] << 16),
        "payload": data[10:10 + payload_len],
    }


# ---------------------------------------------------------------------------
# Multi-frame reassembly
# ---------------------------------------------------------------------------
class MavlinkReassembler:
    """Reassembles MAVLink v2 frames from CAN FD frames keyed by CAN ID.

    A MAVLink v2 frame larger than 64 bytes is transmitted as multiple CAN FD
    frames at the same CAN ID. The first CAN frame starts with 0xFD and its
    second byte is payload_len; the total wire length is 12 + payload_len
    (10-byte header + payload + 2-byte CRC).

    Continuation CAN frames have no identifier, so when two MAVLink messages
    are in flight at the same CAN ID, continuation frames are assigned to the
    oldest incomplete buffer (FIFO).
    """

    def __init__(self):
        # canId -> list of in-flight buffers, each is a dict:
        #   {"chunks": [bytes...], "expected": int, "current": int}
        self._buffers: dict[int, list[dict]] = {}

    def feed(self, can_id: int, data: bytes) -> list[bytes]:
        """Feed a single CAN frame's payload. Returns list of complete MAVLink
        v2 frames that became available (typically 0 or 1).
        """
        complete: list[bytes] = []
        if len(data) == 0:
            return complete

        is_start = data[0] == 0xFD
        if is_start:
            payload_len = data[1] if len(data) > 1 else 0
            expected = 12 + payload_len
            buf = {"chunks": [data], "current": len(data), "expected": expected}
            if buf["current"] >= expected:
                complete.append(self._join(buf, expected))
            else:
                self._buffers.setdefault(can_id, []).append(buf)
        else:
            buffers = self._buffers.get(can_id)
            if buffers:
                buf = buffers[0]
                buf["chunks"].append(data)
                buf["current"] += len(data)
                if buf["current"] >= buf["expected"]:
                    complete.append(self._join(buf, buf["expected"]))
                    buffers.pop(0)
                    if not buffers:
                        del self._buffers[can_id]
        return complete

    def flush(self) -> list[tuple[int, bytes]]:
        """Return and clear all incomplete in-flight buffers as raw bytes."""
        out: list[tuple[int, bytes]] = []
        for can_id, buffers in self._buffers.items():
            for buf in buffers:
                out.append((can_id, b"".join(buf["chunks"])))
        self._buffers.clear()
        return out

    @staticmethod
    def _join(buf: dict, expected: int) -> bytes:
        joined = b"".join(buf["chunks"])
        return joined[:expected]
