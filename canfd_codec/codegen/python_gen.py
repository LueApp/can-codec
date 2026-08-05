"""Python 3 code generator."""

from ..codec import DeviceConfig, Message, Signal
from .common import (
    sanitize_c_id, to_pascal_case, to_snake_case, to_upper_snake,
    signal_max_raw, is_float, is_signed, is_enum, is_bitfield, is_identity_integer,
    physical_field_type_py, resolve_default_raw, resolve_default_physical,
    user_signals, total_payload_bytes,
)


def _py_repr(val) -> str:
    if val is None:
        return "None"
    if isinstance(val, bool):
        return "True" if val else "False"
    if isinstance(val, float):
        if val != val:  # NaN
            return "float('nan')"
        return repr(val)
    return repr(val)


def _runtime_helpers() -> str:
    return '''\
# ===== Bit-level helpers (do not edit) =====
def _ext_le(data, start, length):
    v = 0
    for i in range(length):
        bi = (start + i) // 8
        if bi < len(data) and data[bi] & (1 << ((start + i) % 8)):
            v |= 1 << i
    return v


def _ext_be(data, start, length):
    v = 0
    for i in range(length):
        bp = start + i
        bi = bp // 8
        if bi < len(data) and data[bi] & (1 << (7 - (bp % 8))):
            v |= 1 << (length - 1 - i)
    return v


def _pack_le(data, start, length, value):
    for i in range(length):
        bi = (start + i) // 8
        while bi >= len(data):
            data.append(0)
        if value & (1 << i):
            data[bi] |= 1 << ((start + i) % 8)
        else:
            data[bi] &= ~(1 << ((start + i) % 8))


def _pack_be(data, start, length, value):
    for i in range(length):
        bp = start + i
        bi = bp // 8
        while bi >= len(data):
            data.append(0)
        if value & (1 << (length - 1 - i)):
            data[bi] |= 1 << (7 - (bp % 8))
        else:
            data[bi] &= ~(1 << (7 - (bp % 8)))


def _is_identity(scale, offset):
    """scale=1 且 offset=0 —— 此时不该引入浮点运算。

    ``int((v - 0) / 1.0)`` 会把 v 先转成 float64，而 float64 只有 53 位
    有效位。uint64 字段（比如 STATUS 的 timestamp）因此丢低位：
    ``0xFEDCBA9876543210`` 变成 ``0xFEDCBA9876543000``。
    """
    return scale == 1 and offset == 0


def _p2r_unsigned(v, scale, offset, length):
    if _is_identity(scale, offset):
        raw = int(v)                      # 整数路径，不经 float
    else:
        raw = int((v - offset) / scale) if scale != 0 else 0
    m = (1 << length) - 1
    return max(0, min(raw, m))


def _p2r_signed(v, scale, offset, length):
    if _is_identity(scale, offset):
        raw = int(v)
    else:
        raw = int((v - offset) / scale) if scale != 0 else 0
    if raw < 0:
        raw += 1 << length
    m = (1 << length) - 1
    return max(0, min(raw, m))


def _r2p_unsigned(raw, scale, offset):
    if _is_identity(scale, offset):
        return raw                        # 保持整数，不转 float
    return raw * scale + offset


def _r2p_signed(raw, scale, offset, length):
    if raw >= (1 << (length - 1)):
        raw -= 1 << length
    if _is_identity(scale, offset):
        return raw
    return raw * scale + offset


def _f32_to_u32(v):
    return _struct.unpack("<I", _struct.pack("<f", float(v)))[0]


def _u32_to_f32(raw):
    return _struct.unpack("<f", _struct.pack("<I", raw & 0xFFFFFFFF))[0]


def _f64_to_u64(v):
    return _struct.unpack("<Q", _struct.pack("<d", float(v)))[0]


def _u64_to_f64(raw):
    return _struct.unpack("<d", _struct.pack("<Q", raw & 0xFFFFFFFFFFFFFFFF))[0]
'''


def _emit_enum_class(sig: Signal, msg: Message, lines: list[str]):
    cls_name = f"{to_pascal_case(msg.name)}_{to_snake_case(sig.name)}"
    lines.append(f"class {cls_name}:")
    lines.append(f'    """Enum constants for signal `{sig.name}` of `{msg.name}`."""')
    for raw_val, name in sorted(sig.enum_map.items()):
        const_name = to_upper_snake(name)
        if const_name[0].isdigit():
            const_name = "_" + const_name
        lines.append(f"    {const_name} = {raw_val}")
    lines.append("    _BY_NAME = {")
    for raw_val, name in sorted(sig.enum_map.items()):
        lines.append(f"        {name.lower()!r}: {raw_val},")
    lines.append("    }")
    lines.append("    _BY_VALUE = {")
    for raw_val, name in sorted(sig.enum_map.items()):
        lines.append(f"        {raw_val}: {name!r},")
    lines.append("    }")
    lines.append("    @classmethod")
    lines.append("    def from_name(cls, name):")
    lines.append("        return cls._BY_NAME.get(name.lower())")
    lines.append("    @classmethod")
    lines.append("    def name_of(cls, value):")
    lines.append("        return cls._BY_VALUE.get(int(value))")
    lines.append("")


def _emit_bitfield_class(sig: Signal, msg: Message, lines: list[str]):
    cls_name = f"{to_pascal_case(msg.name)}_{to_snake_case(sig.name)}"
    lines.append(f"class {cls_name}:")
    lines.append(f'    """Bit-flag constants for signal `{sig.name}` of `{msg.name}`."""')
    for bit_pos, name in sorted(sig.bitfield_map.items()):
        const_name = to_upper_snake(name)
        if const_name[0].isdigit():
            const_name = "_" + const_name
        lines.append(f"    {const_name} = 1 << {bit_pos}  # bit {bit_pos}")
    lines.append("    _BITS = {")
    for bit_pos, name in sorted(sig.bitfield_map.items()):
        lines.append(f"        {bit_pos}: {name!r},")
    lines.append("    }")
    lines.append("    @classmethod")
    lines.append("    def names_set(cls, value):")
    lines.append('        """Return the list of flag names that are set in `value`."""')
    lines.append("        return [n for b, n in cls._BITS.items() if value & (1 << b)]")
    lines.append("")


def _emit_encode_sig(sig: Signal, raw_expr: str, lines: list[str], indent: str):
    """Pack a raw int (named `raw_expr`) into `data` for one signal."""
    pack = "_pack_be" if sig.byte_order == "big_endian" else "_pack_le"
    lines.append(f"{indent}{pack}(data, {sig.start_bit}, {sig.bit_length}, {raw_expr})")


def _physical_to_raw_expr(sig: Signal, var: str) -> str:
    """Return a Python expression that computes the raw int from `var`."""
    if is_bitfield(sig) or is_enum(sig):
        return f"int({var}) & {signal_max_raw(sig)}"
    if sig.value_type == "float32":
        return f"_f32_to_u32({var})"
    if sig.value_type == "float64":
        return f"_f64_to_u64({var})"
    if is_identity_integer(sig):
        return f"int({var}) & {signal_max_raw(sig)}"
    if is_signed(sig):
        return f"_p2r_signed({var}, {sig.scale!r}, {sig.offset!r}, {sig.bit_length})"
    return f"_p2r_unsigned({var}, {sig.scale!r}, {sig.offset!r}, {sig.bit_length})"


def _raw_to_physical_expr(sig: Signal, raw_var: str) -> str:
    if is_bitfield(sig) or is_enum(sig):
        return raw_var
    if sig.value_type == "float32":
        return f"_u32_to_f32({raw_var})"
    if sig.value_type == "float64":
        return f"_u64_to_f64({raw_var})"
    if is_identity_integer(sig):
        if is_signed(sig):
            return f"({raw_var} - (1 << {sig.bit_length}) if {raw_var} >= (1 << {sig.bit_length - 1}) else {raw_var})"
        return raw_var
    if is_signed(sig):
        return f"_r2p_signed({raw_var}, {sig.scale!r}, {sig.offset!r}, {sig.bit_length})"
    return f"_r2p_unsigned({raw_var}, {sig.scale!r}, {sig.offset!r})"


def _emit_message_class(msg: Message, lines: list[str]):
    cls_name = to_pascal_case(msg.name)
    byte_count = total_payload_bytes(msg)
    fields = user_signals(msg)
    is_multi = msg.node_count > 1
    has_broadcast = msg.broadcast_node_id is not None

    lines.append(f"@_dataclass")
    lines.append(f"class {cls_name}:")
    desc = (msg.description or "").strip().replace("\n", " ")
    if desc:
        lines.append(f'    """{desc}"""')

    # Class-level metadata (no type annotation -> not a dataclass field)
    lines.append(f"    BASE_ID = {msg.id:#x}")
    lines.append(f"    DLC = {msg.dlc}")
    lines.append(f"    PAYLOAD_BYTES = {byte_count}")
    lines.append(f"    DIRECTION = {msg.direction!r}")
    lines.append(f"    NODE_COUNT = {msg.node_count}")
    lines.append(f"    NODE_ID_OFFSET = {msg.node_id_offset}")
    lines.append(f"    NODE_ID_START = {msg.node_id_start}")
    if msg.crc_extra is not None:
        lines.append(f"    CRC_EXTRA = {msg.crc_extra}")
    if has_broadcast:
        lines.append(f"    BROADCAST_NODE_ID = {msg.broadcast_node_id:#x}")
    else:
        lines.append("    BROADCAST_NODE_ID = None")
    lines.append("")

    # Dataclass fields (one per non-constant signal)
    if not fields:
        lines.append("    pass")
    else:
        for sig in fields:
            ftype = physical_field_type_py(sig)
            field_name = sanitize_c_id(sig.name)
            default_phys = resolve_default_physical(sig)
            if default_phys is None:
                default = "0.0" if ftype == "float" else "0"
            else:
                if ftype == "float":
                    default = repr(float(default_phys))
                else:
                    default = str(int(default_phys))
            unit_comment = f"  # {sig.unit}" if sig.unit else ""
            lines.append(f"    {field_name}: {ftype} = {default}{unit_comment}")

    # node_id is a normal field for round-tripping the source node on decode
    lines.append(f"    node_id: int = {msg.node_id_start}")
    lines.append("")

    # ID helpers
    lines.append("    @classmethod")
    lines.append("    def id_for_node(cls, node_id):")
    if is_multi:
        lines.append("        return cls.BASE_ID + node_id * cls.NODE_ID_OFFSET")
    else:
        lines.append("        return cls.BASE_ID")
    lines.append("")

    lines.append("    @classmethod")
    lines.append("    def node_for_id(cls, can_id):")
    lines.append('        """Return node_id if `can_id` belongs to this message, else None."""')
    if not is_multi:
        lines.append("        return cls.NODE_ID_START if can_id == cls.BASE_ID else None")
    else:
        lines.append("        off = can_id - cls.BASE_ID")
        lines.append("        if cls.NODE_ID_OFFSET == 0:")
        lines.append("            return cls.NODE_ID_START if off == 0 else None")
        lines.append("        if off % cls.NODE_ID_OFFSET != 0:")
        lines.append("            return None")
        lines.append("        nid = off // cls.NODE_ID_OFFSET")
        if has_broadcast:
            lines.append("        if nid == cls.BROADCAST_NODE_ID:")
            lines.append("            return nid")
        lines.append("        if cls.NODE_ID_START <= nid <= cls.NODE_ID_START + cls.NODE_COUNT - 1:")
        lines.append("            return nid")
        lines.append("        return None")
    lines.append("")

    # encode()
    lines.append("    def encode(self, node_id=None):")
    lines.append('        """Pack signal values into raw bytes. Returns (can_id, bytes)."""')
    lines.append("        if node_id is None:")
    lines.append("            node_id = self.node_id")
    lines.append(f"        data = bytearray({byte_count})")
    for sig in msg.signals:
        if sig.constant:
            raw = resolve_default_raw(sig)
            lines.append(f"        # constant: {sig.name} = {sig.default!r}")
            _emit_encode_sig(sig, str(raw), lines, "        ")
        else:
            var = f"self.{sanitize_c_id(sig.name)}"
            raw_expr = _physical_to_raw_expr(sig, var)
            lines.append(f"        # {sig.name}")
            lines.append(f"        _raw = {raw_expr}")
            _emit_encode_sig(sig, "_raw", lines, "        ")
    lines.append("        return self.id_for_node(node_id), bytes(data)")
    lines.append("")

    # decode()
    lines.append("    @classmethod")
    lines.append("    def decode(cls, data, node_id=None):")
    lines.append('        """Parse raw bytes into a message instance."""')
    lines.append(f"        if len(data) < {byte_count}:")
    lines.append(f"            data = bytes(data) + b'\\x00' * ({byte_count} - len(data))")
    lines.append("        m = cls()")
    lines.append("        if node_id is not None:")
    lines.append("            m.node_id = node_id")
    for sig in msg.signals:
        if sig.constant:
            continue
        field_name = sanitize_c_id(sig.name)
        ext = "_ext_be" if sig.byte_order == "big_endian" else "_ext_le"
        lines.append(f"        _raw = {ext}(data, {sig.start_bit}, {sig.bit_length})")
        ftype = physical_field_type_py(sig)
        val_expr = _raw_to_physical_expr(sig, "_raw")
        if ftype == "int":
            val_expr = f"int({val_expr})"
        elif ftype == "float":
            val_expr = f"float({val_expr})"
        lines.append(f"        m.{field_name} = {val_expr}")
    lines.append("        return m")
    lines.append("")

    # Broadcast helpers
    if has_broadcast:
        lines.append("    @classmethod")
        lines.append("    def encode_broadcast(cls, nodes):")
        lines.append('        """Pack a list of NODE_COUNT instances into one broadcast frame.')
        lines.append('        Returns (can_id, bytes)."""')
        lines.append("        if len(nodes) != cls.NODE_COUNT:")
        lines.append("            raise ValueError(")
        lines.append("                f'Broadcast expects {cls.NODE_COUNT} nodes, got {len(nodes)}'")
        lines.append("            )")
        lines.append("        data = bytearray()")
        lines.append("        for i, n in enumerate(nodes):")
        lines.append("            _, p = n.encode(node_id=cls.NODE_ID_START + i)")
        lines.append("            data.extend(p)")
        lines.append("        can_id = cls.BASE_ID + cls.BROADCAST_NODE_ID * cls.NODE_ID_OFFSET")
        lines.append("        return can_id, bytes(data)")
        lines.append("")
        lines.append("    @classmethod")
        lines.append("    def decode_broadcast(cls, data):")
        lines.append('        """Split a broadcast frame into per-node instances."""')
        lines.append("        size = cls.PAYLOAD_BYTES")
        lines.append("        need = size * cls.NODE_COUNT")
        lines.append("        if len(data) < need:")
        lines.append("            data = bytes(data) + b'\\x00' * (need - len(data))")
        lines.append("        out = []")
        lines.append("        for i in range(cls.NODE_COUNT):")
        lines.append("            seg = data[i*size:(i+1)*size]")
        lines.append("            out.append(cls.decode(seg, node_id=cls.NODE_ID_START + i))")
        lines.append("        return out")
        lines.append("")


def generate_python(device: DeviceConfig) -> str:
    L: list[str] = []
    L.append(f'"""Auto-generated CAN/CAN-FD codec for device: {device.name}')
    if device.description:
        L.append("")
        L.append(device.description)
    L.append("")
    L.append("Generated by canfd-codec. DO NOT EDIT BY HAND — regenerate with:")
    L.append("    canfd-codec -c <config> genlib --lang python")
    L.append('"""')
    L.append("import struct as _struct")
    L.append("from dataclasses import dataclass as _dataclass")
    L.append("")
    L.append(f"DEVICE_NAME = {device.name!r}")
    if not device.mavlink:
        L.append(f"DEVICE_BUS = {device.bus!r}")
        L.append(f"DEVICE_FD = {device.fd!r}")
        L.append(f"DEVICE_BITRATE = {device.bitrate}")
        if device.fd:
            L.append(f"DEVICE_DATA_BITRATE = {device.data_bitrate}")
    L.append("")
    L.append(_runtime_helpers())
    L.append("")

    # Enum / bitfield constants per signal
    L.append("# ===== Enum and bitfield constants =====")
    for msg in device.messages:
        for sig in msg.signals:
            if is_enum(sig):
                _emit_enum_class(sig, msg, L)
            elif is_bitfield(sig):
                _emit_bitfield_class(sig, msg, L)

    L.append("# ===== Message classes =====")
    for msg in device.messages:
        _emit_message_class(msg, L)

    # Top-level dispatch
    L.append("# ===== Top-level dispatch =====")
    L.append("ALL_MESSAGES = [")
    for msg in device.messages:
        L.append(f"    {to_pascal_case(msg.name)},")
    L.append("]")
    L.append("")
    L.append("MESSAGES_BY_NAME = {cls.__name__: cls for cls in ALL_MESSAGES}")
    L.append("")
    L.append("def decode_frame(can_id, data):")
    L.append('    """Find the right message class for `can_id` and decode `data`.')
    L.append("    Returns the decoded instance (a list for broadcast frames), or None")
    L.append('    if the ID is unknown."""')
    L.append("    for cls in ALL_MESSAGES:")
    L.append("        nid = cls.node_for_id(can_id)")
    L.append("        if nid is None:")
    L.append("            continue")
    L.append("        if cls.BROADCAST_NODE_ID is not None and nid == cls.BROADCAST_NODE_ID:")
    L.append("            expected = cls.PAYLOAD_BYTES * cls.NODE_COUNT")
    L.append("            if len(data) == expected:")
    L.append("                return cls.decode_broadcast(data)")
    L.append("        return cls.decode(data, node_id=nid)")
    L.append("    return None")
    L.append("")
    L.append("__all__ = [")
    if device.mavlink:
        L.append("    'DEVICE_NAME',")
    else:
        L.append("    'DEVICE_NAME', 'DEVICE_BUS', 'DEVICE_FD',")
    L.append("    'ALL_MESSAGES', 'MESSAGES_BY_NAME', 'decode_frame',")
    for msg in device.messages:
        L.append(f"    {to_pascal_case(msg.name)!r},")
    L.append("]")
    L.append("")
    return "\n".join(L)
