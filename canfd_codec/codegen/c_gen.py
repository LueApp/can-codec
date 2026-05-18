"""C99 header-only generator."""

from ..codec import DeviceConfig, Message, Signal
from .common import (
    sanitize_c_id, to_snake_case, to_upper_snake,
    signal_max_raw, fitting_uint_bits, c_uint_type, c_int_type,
    is_float, is_signed, is_enum, is_bitfield,
    physical_field_type_c, resolve_default_raw, resolve_default_physical,
    user_signals, total_payload_bytes,
)


def _device_prefix(device: DeviceConfig) -> str:
    return to_snake_case(device.name) or "device"


def _msg_prefix(device: DeviceConfig, msg: Message) -> str:
    return f"{_device_prefix(device)}_{to_snake_case(msg.name)}"


def _runtime_helpers() -> str:
    return r'''
/* ===== Internal bit / float helpers (do not call directly) ===== */
static inline uint64_t _ccgen_ext_le(const uint8_t* data, size_t len, int start, int length) {
    uint64_t v = 0;
    for (int i = 0; i < length; ++i) {
        int bi = (start + i) >> 3;
        if ((size_t)bi < len && (data[bi] & (1u << ((start + i) & 7)))) {
            v |= (uint64_t)1 << i;
        }
    }
    return v;
}

static inline uint64_t _ccgen_ext_be(const uint8_t* data, size_t len, int start, int length) {
    uint64_t v = 0;
    for (int i = 0; i < length; ++i) {
        int bp = start + i;
        int bi = bp >> 3;
        if ((size_t)bi < len && (data[bi] & (1u << (7 - (bp & 7))))) {
            v |= (uint64_t)1 << (length - 1 - i);
        }
    }
    return v;
}

static inline void _ccgen_pack_le(uint8_t* data, size_t len, int start, int length, uint64_t value) {
    for (int i = 0; i < length; ++i) {
        int bi = (start + i) >> 3;
        if ((size_t)bi >= len) break;
        int b = (start + i) & 7;
        if (value & ((uint64_t)1 << i)) data[bi] |=  (uint8_t)(1u << b);
        else                            data[bi] &= (uint8_t)~(1u << b);
    }
}

static inline void _ccgen_pack_be(uint8_t* data, size_t len, int start, int length, uint64_t value) {
    for (int i = 0; i < length; ++i) {
        int bp = start + i;
        int bi = bp >> 3;
        if ((size_t)bi >= len) break;
        int b = 7 - (bp & 7);
        if (value & ((uint64_t)1 << (length - 1 - i))) data[bi] |=  (uint8_t)(1u << b);
        else                                           data[bi] &= (uint8_t)~(1u << b);
    }
}

static inline int64_t _ccgen_sign_extend(uint64_t raw, int length) {
    if (length >= 64) return (int64_t)raw;
    uint64_t sign = (uint64_t)1 << (length - 1);
    if (raw & sign) {
        return (int64_t)(raw | (~(uint64_t)0 << length));
    }
    return (int64_t)raw;
}

static inline uint32_t _ccgen_f32_to_u32(float v) {
    uint32_t out;
    memcpy(&out, &v, 4);
    return out;
}

static inline float _ccgen_u32_to_f32(uint32_t raw) {
    float out;
    memcpy(&out, &raw, 4);
    return out;
}

static inline uint64_t _ccgen_f64_to_u64(double v) {
    uint64_t out;
    memcpy(&out, &v, 8);
    return out;
}

static inline double _ccgen_u64_to_f64(uint64_t raw) {
    double out;
    memcpy(&out, &raw, 8);
    return out;
}

static inline uint64_t _ccgen_clamp_u(int64_t raw, int length) {
    int64_t maxv = (length >= 64) ? (int64_t)((uint64_t)~0ULL) : (int64_t)(((uint64_t)1 << length) - 1);
    if (raw < 0) return 0;
    if (raw > maxv) return (uint64_t)maxv;
    return (uint64_t)raw;
}

static inline uint64_t _ccgen_phys_to_raw_signed(double v, double scale, double offset, int length) {
    double r = (scale != 0) ? (v - offset) / scale : 0;
    int64_t raw = (int64_t)r;
    if (raw < 0) raw += (int64_t)1 << length;
    return _ccgen_clamp_u(raw, length);
}

static inline uint64_t _ccgen_phys_to_raw_unsigned(double v, double scale, double offset, int length) {
    double r = (scale != 0) ? (v - offset) / scale : 0;
    int64_t raw = (int64_t)r;
    return _ccgen_clamp_u(raw, length);
}

static inline double _ccgen_raw_to_phys_signed(uint64_t raw, double scale, double offset, int length) {
    return (double)_ccgen_sign_extend(raw, length) * scale + offset;
}

static inline double _ccgen_raw_to_phys_unsigned(uint64_t raw, double scale, double offset) {
    return (double)raw * scale + offset;
}
'''


def _emit_enum(sig: Signal, msg: Message, device: DeviceConfig, lines: list[str]):
    prefix = f"{_msg_prefix(device, msg)}_{to_snake_case(sig.name)}".upper()
    for raw_val, name in sorted(sig.enum_map.items()):
        macro = f"{prefix}_{to_upper_snake(name)}"
        lines.append(f"#define {macro} ((uint32_t){raw_val}u)")
    lines.append("")


def _emit_bitfield(sig: Signal, msg: Message, device: DeviceConfig, lines: list[str]):
    prefix = f"{_msg_prefix(device, msg)}_{to_snake_case(sig.name)}".upper()
    for bit_pos, name in sorted(sig.bitfield_map.items()):
        macro = f"{prefix}_{to_upper_snake(name)}"
        lines.append(f"#define {macro} ((uint32_t)1u << {bit_pos})")
    lines.append("")


def _phys_to_raw_call(sig: Signal, var: str) -> str:
    if is_bitfield(sig) or is_enum(sig):
        return f"((uint64_t)({var}) & {signal_max_raw(sig)}ull)"
    if sig.value_type == "float32":
        return f"(uint64_t)_ccgen_f32_to_u32((float)({var}))"
    if sig.value_type == "float64":
        return f"_ccgen_f64_to_u64((double)({var}))"
    fn = "_ccgen_phys_to_raw_signed" if is_signed(sig) else "_ccgen_phys_to_raw_unsigned"
    return f"{fn}((double)({var}), {sig.scale!r}, {sig.offset!r}, {sig.bit_length})"


def _raw_to_phys_call(sig: Signal, raw_var: str) -> str:
    if is_bitfield(sig) or is_enum(sig):
        return raw_var
    if sig.value_type == "float32":
        return f"_ccgen_u32_to_f32((uint32_t)({raw_var}))"
    if sig.value_type == "float64":
        return f"_ccgen_u64_to_f64({raw_var})"
    if is_signed(sig):
        return f"_ccgen_raw_to_phys_signed({raw_var}, {sig.scale!r}, {sig.offset!r}, {sig.bit_length})"
    return f"_ccgen_raw_to_phys_unsigned({raw_var}, {sig.scale!r}, {sig.offset!r})"


def _emit_struct(device: DeviceConfig, msg: Message, lines: list[str]):
    prefix = _msg_prefix(device, msg)
    byte_count = total_payload_bytes(msg)
    fields = user_signals(msg)

    desc = (msg.description or "").strip().replace("\n", " ")
    lines.append(f"/* ---- {msg.name} (id=0x{msg.id:X}, dlc={msg.dlc}) ---- */")
    if desc:
        lines.append(f"/* {desc} */")
    lines.append(f"#define {prefix}_BASE_ID      0x{msg.id:X}u")
    lines.append(f"#define {prefix}_DLC          {msg.dlc}")
    lines.append(f"#define {prefix}_PAYLOAD_BYTES {byte_count}")
    lines.append(f"#define {prefix}_NODE_COUNT   {msg.node_count}")
    lines.append(f"#define {prefix}_NODE_ID_OFFSET {msg.node_id_offset}")
    lines.append(f"#define {prefix}_NODE_ID_START {msg.node_id_start}")
    if msg.broadcast_node_id is not None:
        lines.append(f"#define {prefix}_BROADCAST_NODE_ID 0x{msg.broadcast_node_id:X}u")
    lines.append("")

    lines.append("typedef struct {")
    for sig in fields:
        ftype = physical_field_type_c(sig)
        unit = f"  /* {sig.unit} */" if sig.unit else ""
        lines.append(f"    {ftype} {sanitize_c_id(sig.name)};{unit}")
    if not fields:
        lines.append("    uint8_t _unused;  /* no user-facing signals */")
    lines.append(f"}} {prefix}_t;")
    lines.append("")

    # Initializer macro with defaults
    init_parts = []
    for sig in fields:
        d = resolve_default_physical(sig)
        if d is None:
            init_parts.append("0")
        else:
            ftype = physical_field_type_c(sig)
            if ftype in ("float", "double"):
                init_parts.append(f"{float(d):.17g}")
            else:
                init_parts.append(str(int(d)))
    if init_parts:
        lines.append(f"#define {prefix.upper()}_INIT {{ {', '.join(init_parts)} }}")
    lines.append("")

    # id_for_node / node_for_id
    lines.append(f"static inline uint32_t {prefix}_id_for_node(uint32_t node_id) {{")
    if msg.node_count > 1:
        lines.append(f"    return {prefix}_BASE_ID + node_id * {prefix}_NODE_ID_OFFSET;")
    else:
        lines.append(f"    (void)node_id; return {prefix}_BASE_ID;")
    lines.append("}")
    lines.append("")

    lines.append(f"static inline int {prefix}_node_for_id(uint32_t can_id, uint32_t* out_node_id) {{")
    if msg.node_count <= 1:
        lines.append(f"    if (can_id == {prefix}_BASE_ID) {{ if (out_node_id) *out_node_id = {prefix}_NODE_ID_START; return 1; }}")
        lines.append("    return 0;")
    else:
        lines.append(f"    int32_t off = (int32_t)can_id - (int32_t){prefix}_BASE_ID;")
        lines.append(f"    if ({prefix}_NODE_ID_OFFSET == 0) {{")
        lines.append(f"        if (off == 0) {{ if (out_node_id) *out_node_id = {prefix}_NODE_ID_START; return 1; }}")
        lines.append("        return 0;")
        lines.append("    }")
        lines.append(f"    if (off % {prefix}_NODE_ID_OFFSET != 0) return 0;")
        lines.append(f"    int32_t nid = off / {prefix}_NODE_ID_OFFSET;")
        if msg.broadcast_node_id is not None:
            lines.append(f"    if ((uint32_t)nid == {prefix}_BROADCAST_NODE_ID) {{ if (out_node_id) *out_node_id = (uint32_t)nid; return 1; }}")
        lines.append(f"    if (nid >= (int32_t){prefix}_NODE_ID_START && nid < (int32_t)({prefix}_NODE_ID_START + {prefix}_NODE_COUNT)) {{")
        lines.append("        if (out_node_id) *out_node_id = (uint32_t)nid;")
        lines.append("        return 1;")
        lines.append("    }")
        lines.append("    return 0;")
    lines.append("}")
    lines.append("")

    # encode()
    lines.append(f"static inline size_t {prefix}_encode(const {prefix}_t* src, uint8_t* data, size_t cap) {{")
    lines.append(f"    if (cap < {byte_count}) return 0;")
    if not fields:
        lines.append("    (void)src;")
    lines.append(f"    for (size_t _i = 0; _i < {byte_count}; ++_i) data[_i] = 0;")
    for sig in msg.signals:
        if sig.constant:
            raw = resolve_default_raw(sig)
            lines.append(f"    /* constant: {sig.name} = {sig.default!r} */")
            pack = "_ccgen_pack_be" if sig.byte_order == "big_endian" else "_ccgen_pack_le"
            lines.append(f"    {pack}(data, {byte_count}, {sig.start_bit}, {sig.bit_length}, (uint64_t){raw}ull);")
        else:
            var = f"src->{sanitize_c_id(sig.name)}"
            raw_expr = _phys_to_raw_call(sig, var)
            lines.append(f"    {{ uint64_t _raw = {raw_expr};")
            pack = "_ccgen_pack_be" if sig.byte_order == "big_endian" else "_ccgen_pack_le"
            lines.append(f"      {pack}(data, {byte_count}, {sig.start_bit}, {sig.bit_length}, _raw); }}")
    lines.append(f"    return {byte_count};")
    lines.append("}")
    lines.append("")

    # decode()
    lines.append(f"static inline int {prefix}_decode(const uint8_t* data, size_t len, {prefix}_t* dst) {{")
    lines.append(f"    if (len < {byte_count}) return 0;")
    if not fields:
        lines.append("    (void)data; (void)dst;")
    for sig in msg.signals:
        if sig.constant:
            continue
        field_name = sanitize_c_id(sig.name)
        ext = "_ccgen_ext_be" if sig.byte_order == "big_endian" else "_ccgen_ext_le"
        ftype = physical_field_type_c(sig)
        lines.append(f"    {{ uint64_t _raw = {ext}(data, len, {sig.start_bit}, {sig.bit_length});")
        val = _raw_to_phys_call(sig, "_raw")
        lines.append(f"      dst->{field_name} = ({ftype})({val}); }}")
    lines.append("    return 1;")
    lines.append("}")
    lines.append("")

    # Broadcast helpers
    if msg.broadcast_node_id is not None:
        n = msg.node_count
        seg = byte_count
        total = n * seg
        lines.append(f"static inline size_t {prefix}_encode_broadcast(const {prefix}_t nodes[{n}], uint8_t* data, size_t cap) {{")
        lines.append(f"    if (cap < {total}) return 0;")
        lines.append(f"    for (size_t _i = 0; _i < {total}; ++_i) data[_i] = 0;")
        lines.append(f"    for (size_t i = 0; i < {n}; ++i) {{")
        lines.append(f"        {prefix}_encode(&nodes[i], data + i * {seg}, {seg});")
        lines.append("    }")
        lines.append(f"    return {total};")
        lines.append("}")
        lines.append("")
        lines.append(f"static inline int {prefix}_decode_broadcast(const uint8_t* data, size_t len, {prefix}_t nodes[{n}]) {{")
        lines.append(f"    if (len < {total}) return 0;")
        lines.append(f"    for (size_t i = 0; i < {n}; ++i) {{")
        lines.append(f"        {prefix}_decode(data + i * {seg}, {seg}, &nodes[i]);")
        lines.append("    }")
        lines.append("    return 1;")
        lines.append("}")
        lines.append("")
        lines.append(f"static inline uint32_t {prefix}_broadcast_id(void) {{")
        lines.append(f"    return {prefix}_BASE_ID + {prefix}_BROADCAST_NODE_ID * {prefix}_NODE_ID_OFFSET;")
        lines.append("}")
        lines.append("")


def generate_c(device: DeviceConfig) -> str:
    prefix = _device_prefix(device)
    guard = f"{prefix.upper()}_CODEC_H"

    L: list[str] = []
    L.append("/*")
    L.append(f" * Auto-generated CAN/CAN-FD codec for device: {device.name}")
    if device.description:
        L.append(f" *")
        for line in device.description.splitlines():
            L.append(f" * {line}")
    L.append(" *")
    L.append(" * Generated by canfd-codec. DO NOT EDIT BY HAND.")
    L.append(" * Regenerate with: canfd-codec -c <config> genlib --lang c")
    L.append(" */")
    L.append(f"#ifndef {guard}")
    L.append(f"#define {guard}")
    L.append("")
    L.append("#include <stdint.h>")
    L.append("#include <stddef.h>")
    L.append("#include <string.h>")
    L.append("")
    L.append("#ifdef __cplusplus")
    L.append('extern "C" {')
    L.append("#endif")
    L.append("")
    L.append(f"#define {prefix.upper()}_DEVICE_NAME    \"{device.name}\"")
    L.append(f"#define {prefix.upper()}_DEVICE_FD      {1 if device.fd else 0}")
    L.append(f"#define {prefix.upper()}_DEVICE_BITRATE {device.bitrate}u")
    if device.fd:
        L.append(f"#define {prefix.upper()}_DATA_BITRATE   {device.data_bitrate}u")
    L.append("")
    L.append(_runtime_helpers())
    L.append("")
    L.append("/* ===== Enum / bitfield constants ===== */")
    for msg in device.messages:
        for sig in msg.signals:
            if is_enum(sig):
                _emit_enum(sig, msg, device, L)
            elif is_bitfield(sig):
                _emit_bitfield(sig, msg, device, L)
    L.append("")
    L.append("/* ===== Message structs & encode/decode ===== */")
    for msg in device.messages:
        _emit_struct(device, msg, L)

    L.append("#ifdef __cplusplus")
    L.append("} /* extern \"C\" */")
    L.append("#endif")
    L.append("")
    L.append(f"#endif /* {guard} */")
    L.append("")
    return "\n".join(L)
