"""
MAVLink XML message definition loader.

Converts MAVLink XML message definitions to the internal codec format.
Supports enums, messages with typed fields, and arrays.

Usage:
    from canfd_codec.mavlink_loader import load_mavlink_xml

    config = load_mavlink_xml("message_definitions/your_mavlink.xml")
"""

import re
import xml.etree.ElementTree as ET
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any

from .codec import Signal, Message, DeviceConfig


# MAVLink type to (bit_length, value_type, is_array_element_size)
MAVLINK_TYPES = {
    "uint8_t": (8, "unsigned"),
    "int8_t": (8, "signed"),
    "uint16_t": (16, "unsigned"),
    "int16_t": (16, "signed"),
    "uint32_t": (32, "unsigned"),
    "int32_t": (32, "signed"),
    "uint64_t": (64, "unsigned"),
    "int64_t": (64, "signed"),
    "float": (32, "float32"),
    "double": (64, "float64"),
    "char": (8, "unsigned"),  # char is treated as uint8
}


def _parse_type(type_str: str) -> tuple[int, str, int]:
    """
    Parse a MAVLink type string.

    Returns: (bit_length, value_type, array_count)
    array_count is 1 for non-arrays.
    """
    # Check for array syntax: type[N]
    array_match = re.match(r"(\w+)\[(\d+)\]", type_str)
    if array_match:
        base_type = array_match.group(1)
        array_count = int(array_match.group(2))
    else:
        base_type = type_str
        array_count = 1

    if base_type not in MAVLINK_TYPES:
        raise ValueError(f"Unknown MAVLink type: {base_type}")

    bit_length, value_type = MAVLINK_TYPES[base_type]
    return bit_length, value_type, array_count


def _parse_enums(root: ET.Element) -> dict[str, dict[int, str]]:
    """Parse all enum definitions from the XML."""
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
                # Use short name (strip enum prefix if present)
                short_name = name
                if short_name.startswith(enum_name + "_"):
                    short_name = short_name[len(enum_name) + 1:]
                values[int(value)] = short_name.lower()

        enums[enum_name] = values

    return enums


def _parse_messages(root: ET.Element, enums: dict[str, dict[int, str]]) -> list[Message]:
    """Parse all message definitions from the XML."""
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

        signals = []
        bit_offset = 0

        for field_elem in msg_elem.findall("field"):
            field_type = field_elem.get("type")
            field_name = field_elem.get("name")
            field_enum = field_elem.get("enum")
            field_desc = field_elem.text.strip() if field_elem.text else ""

            if not field_type or not field_name:
                continue

            try:
                bit_length, value_type, array_count = _parse_type(field_type)
            except ValueError as e:
                # Skip unknown types
                continue

            # Get enum map if specified
            enum_map = {}
            if field_enum and field_enum in enums:
                enum_map = enums[field_enum]

            if array_count > 1:
                # For arrays, create individual signals for each element
                for i in range(array_count):
                    sig = Signal(
                        name=f"{field_name}_{i}" if array_count > 1 else field_name,
                        start_bit=bit_offset,
                        bit_length=bit_length,
                        byte_order="little_endian",
                        value_type=value_type,
                        description=f"{field_desc} [index {i}]" if field_desc else f"[index {i}]",
                        enum_map=enum_map.copy() if enum_map else {},
                    )
                    signals.append(sig)
                    bit_offset += bit_length
            else:
                sig = Signal(
                    name=field_name,
                    start_bit=bit_offset,
                    bit_length=bit_length,
                    byte_order="little_endian",
                    value_type=value_type,
                    description=field_desc,
                    enum_map=enum_map,
                )
                signals.append(sig)
                bit_offset += bit_length

        # Calculate DLC (round up to bytes)
        dlc = (bit_offset + 7) // 8

        msg = Message(
            id=msg_id,
            name=msg_name,
            direction="tx",
            dlc=dlc,
            description=description,
            signals=signals,
        )
        messages.append(msg)

    return messages


def load_mavlink_xml(path: str | Path) -> DeviceConfig:
    """
    Load a MAVLink XML message definition file.

    Args:
        path: Path to the XML file

    Returns:
        DeviceConfig with parsed messages
    """
    path = Path(path)
    tree = ET.parse(path)
    root = tree.getroot()

    # Parse enums first (they're referenced by messages)
    enums = _parse_enums(root)

    # Parse messages
    messages = _parse_messages(root, enums)

    # Get version info
    version = ""
    version_elem = root.find("version")
    if version_elem is not None and version_elem.text:
        version = version_elem.text.strip()

    config = DeviceConfig(
        name=path.stem,
        version=f"MAVLink v{version}" if version else "MAVLink",
        description=f"MAVLink messages from {path.name}",
        fd=True,  # MAVLink messages can be large, use FD
        messages=messages,
    )
    config.build_lookups()

    return config


def load_mavlink_directory(path: str | Path) -> list[DeviceConfig]:
    """Load all MAVLink XML files from a directory."""
    path = Path(path)
    configs = []

    for xml_file in sorted(path.glob("*.xml")):
        try:
            config = load_mavlink_xml(xml_file)
            configs.append(config)
        except ET.ParseError as e:
            print(f"Warning: Failed to parse {xml_file}: {e}")

    return configs
