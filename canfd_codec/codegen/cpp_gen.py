"""C++17 header-only generator."""

from ..codec import DeviceConfig, Message, Signal
from .common import (
    sanitize_c_id, to_snake_case, to_pascal_case, to_upper_snake,
    signal_max_raw, c_uint_type, c_int_type,
    is_float, is_signed, is_enum, is_bitfield,
    physical_field_type_c, resolve_default_raw, resolve_default_physical,
    user_signals, total_payload_bytes,
)


def _device_ns(device: DeviceConfig) -> str:
    return to_snake_case(device.name) or "device"


def _runtime_helpers() -> str:
    return r'''
namespace detail {

inline uint64_t ext_le(const uint8_t* d, std::size_t len, int start, int length) {
    uint64_t v = 0;
    for (int i = 0; i < length; ++i) {
        int bi = (start + i) >> 3;
        if (static_cast<std::size_t>(bi) < len && (d[bi] & (1u << ((start + i) & 7))))
            v |= (uint64_t)1 << i;
    }
    return v;
}

inline uint64_t ext_be(const uint8_t* d, std::size_t len, int start, int length) {
    uint64_t v = 0;
    for (int i = 0; i < length; ++i) {
        int bp = start + i;
        int bi = bp >> 3;
        if (static_cast<std::size_t>(bi) < len && (d[bi] & (1u << (7 - (bp & 7)))))
            v |= (uint64_t)1 << (length - 1 - i);
    }
    return v;
}

inline void pack_le(uint8_t* d, std::size_t len, int start, int length, uint64_t value) {
    for (int i = 0; i < length; ++i) {
        int bi = (start + i) >> 3;
        if (static_cast<std::size_t>(bi) >= len) break;
        int b = (start + i) & 7;
        if (value & ((uint64_t)1 << i)) d[bi] |=  static_cast<uint8_t>(1u << b);
        else                            d[bi] &= static_cast<uint8_t>(~(1u << b));
    }
}

inline void pack_be(uint8_t* d, std::size_t len, int start, int length, uint64_t value) {
    for (int i = 0; i < length; ++i) {
        int bp = start + i;
        int bi = bp >> 3;
        if (static_cast<std::size_t>(bi) >= len) break;
        int b = 7 - (bp & 7);
        if (value & ((uint64_t)1 << (length - 1 - i))) d[bi] |=  static_cast<uint8_t>(1u << b);
        else                                           d[bi] &= static_cast<uint8_t>(~(1u << b));
    }
}

inline int64_t sign_extend(uint64_t raw, int length) {
    if (length >= 64) return static_cast<int64_t>(raw);
    uint64_t sign = (uint64_t)1 << (length - 1);
    if (raw & sign) return static_cast<int64_t>(raw | (~(uint64_t)0 << length));
    return static_cast<int64_t>(raw);
}

inline uint32_t f32_to_u32(float v) { uint32_t o; std::memcpy(&o, &v, 4); return o; }
inline float    u32_to_f32(uint32_t r) { float o; std::memcpy(&o, &r, 4); return o; }
inline uint64_t f64_to_u64(double v) { uint64_t o; std::memcpy(&o, &v, 8); return o; }
inline double   u64_to_f64(uint64_t r) { double o; std::memcpy(&o, &r, 8); return o; }

inline uint64_t clamp_u(int64_t raw, int length) {
    int64_t maxv = (length >= 64) ? static_cast<int64_t>(static_cast<uint64_t>(~0ULL))
                                  : static_cast<int64_t>(((uint64_t)1 << length) - 1);
    if (raw < 0) return 0;
    if (raw > maxv) return static_cast<uint64_t>(maxv);
    return static_cast<uint64_t>(raw);
}

inline uint64_t phys_to_raw_signed(double v, double scale, double offset, int length) {
    double r = (scale != 0) ? (v - offset) / scale : 0;
    int64_t raw = static_cast<int64_t>(r);
    if (raw < 0) raw += static_cast<int64_t>(1) << length;
    return clamp_u(raw, length);
}

inline uint64_t phys_to_raw_unsigned(double v, double scale, double offset, int length) {
    double r = (scale != 0) ? (v - offset) / scale : 0;
    return clamp_u(static_cast<int64_t>(r), length);
}

inline double raw_to_phys_signed(uint64_t raw, double scale, double offset, int length) {
    return static_cast<double>(sign_extend(raw, length)) * scale + offset;
}

inline double raw_to_phys_unsigned(uint64_t raw, double scale, double offset) {
    return static_cast<double>(raw) * scale + offset;
}

}  // namespace detail
'''


def _emit_enum(sig: Signal, msg: Message, lines: list[str]):
    cls_name = f"{to_pascal_case(msg.name)}_{to_snake_case(sig.name)}"
    lines.append(f"namespace {to_snake_case(msg.name)}_enums {{")
    lines.append(f"// Enum constants for {msg.name}.{sig.name}")
    for raw_val, name in sorted(sig.enum_map.items()):
        const_name = to_upper_snake(name)
        if const_name and const_name[0].isdigit():
            const_name = "_" + const_name
        lines.append(f"inline constexpr uint32_t {to_snake_case(sig.name)}_{const_name} = {raw_val}u;")
    lines.append("}")
    lines.append("")


def _emit_bitfield(sig: Signal, msg: Message, lines: list[str]):
    lines.append(f"namespace {to_snake_case(msg.name)}_flags {{")
    lines.append(f"// Bitfield flags for {msg.name}.{sig.name}")
    for bit_pos, name in sorted(sig.bitfield_map.items()):
        const_name = to_upper_snake(name)
        if const_name and const_name[0].isdigit():
            const_name = "_" + const_name
        lines.append(f"inline constexpr uint32_t {to_snake_case(sig.name)}_{const_name} = 1u << {bit_pos};")
    lines.append("}")
    lines.append("")


def _phys_to_raw_call(sig: Signal, var: str) -> str:
    if is_bitfield(sig) or is_enum(sig):
        return f"(static_cast<uint64_t>({var}) & {signal_max_raw(sig)}ull)"
    if sig.value_type == "float32":
        return f"static_cast<uint64_t>(detail::f32_to_u32(static_cast<float>({var})))"
    if sig.value_type == "float64":
        return f"detail::f64_to_u64(static_cast<double>({var}))"
    fn = "detail::phys_to_raw_signed" if is_signed(sig) else "detail::phys_to_raw_unsigned"
    return f"{fn}(static_cast<double>({var}), {sig.scale!r}, {sig.offset!r}, {sig.bit_length})"


def _raw_to_phys_call(sig: Signal, raw_var: str) -> str:
    if is_bitfield(sig) or is_enum(sig):
        return raw_var
    if sig.value_type == "float32":
        return f"detail::u32_to_f32(static_cast<uint32_t>({raw_var}))"
    if sig.value_type == "float64":
        return f"detail::u64_to_f64({raw_var})"
    if is_signed(sig):
        return f"detail::raw_to_phys_signed({raw_var}, {sig.scale!r}, {sig.offset!r}, {sig.bit_length})"
    return f"detail::raw_to_phys_unsigned({raw_var}, {sig.scale!r}, {sig.offset!r})"


def _emit_struct(msg: Message, lines: list[str]):
    cls = to_pascal_case(msg.name)
    byte_count = total_payload_bytes(msg)
    fields = user_signals(msg)
    is_multi = msg.node_count > 1
    has_broadcast = msg.broadcast_node_id is not None

    desc = (msg.description or "").strip().replace("\n", " ")
    lines.append(f"// ---- {msg.name} (id=0x{msg.id:X}, dlc={msg.dlc}) ----")
    if desc:
        lines.append(f"// {desc}")
    lines.append(f"struct {cls} {{")
    lines.append(f"    static constexpr uint32_t BASE_ID = 0x{msg.id:X}u;")
    lines.append(f"    static constexpr std::size_t DLC = {msg.dlc};")
    lines.append(f"    static constexpr std::size_t PAYLOAD_BYTES = {byte_count};")
    lines.append(f"    static constexpr uint32_t NODE_COUNT = {msg.node_count}u;")
    lines.append(f"    static constexpr uint32_t NODE_ID_OFFSET = {msg.node_id_offset}u;")
    lines.append(f"    static constexpr uint32_t NODE_ID_START = {msg.node_id_start}u;")
    if has_broadcast:
        lines.append(f"    static constexpr uint32_t BROADCAST_NODE_ID = 0x{msg.broadcast_node_id:X}u;")
    lines.append("")

    # Fields with default initializers
    for sig in fields:
        ftype = physical_field_type_c(sig)
        name = sanitize_c_id(sig.name)
        d = resolve_default_physical(sig)
        if d is None:
            default = "{}"
        elif ftype in ("float", "double"):
            default = f"{{ {float(d):.17g} }}"
        else:
            default = f"{{ {int(d)} }}"
        unit = f"  // {sig.unit}" if sig.unit else ""
        lines.append(f"    {ftype} {name}{default};{unit}")
    if is_multi:
        lines.append(f"    uint32_t node_id{{ {msg.node_id_start} }};  // source node for decoded frames")
    lines.append("")

    # id_for_node
    lines.append("    static constexpr uint32_t id_for_node(uint32_t nid) noexcept {")
    if is_multi:
        lines.append("        return BASE_ID + nid * NODE_ID_OFFSET;")
    else:
        lines.append("        (void)nid; return BASE_ID;")
    lines.append("    }")
    lines.append("")

    # node_for_id
    lines.append("    static bool node_for_id(uint32_t can_id, uint32_t& out_nid) noexcept {")
    if not is_multi:
        lines.append("        if (can_id == BASE_ID) { out_nid = NODE_ID_START; return true; }")
        lines.append("        return false;")
    else:
        lines.append("        int32_t off = static_cast<int32_t>(can_id) - static_cast<int32_t>(BASE_ID);")
        lines.append("        if (NODE_ID_OFFSET == 0) {")
        lines.append("            if (off == 0) { out_nid = NODE_ID_START; return true; }")
        lines.append("            return false;")
        lines.append("        }")
        lines.append("        if (off % static_cast<int32_t>(NODE_ID_OFFSET) != 0) return false;")
        lines.append("        int32_t nid = off / static_cast<int32_t>(NODE_ID_OFFSET);")
        if has_broadcast:
            lines.append("        if (static_cast<uint32_t>(nid) == BROADCAST_NODE_ID) { out_nid = static_cast<uint32_t>(nid); return true; }")
        lines.append("        if (nid >= static_cast<int32_t>(NODE_ID_START) && nid < static_cast<int32_t>(NODE_ID_START + NODE_COUNT)) {")
        lines.append("            out_nid = static_cast<uint32_t>(nid);")
        lines.append("            return true;")
        lines.append("        }")
        lines.append("        return false;")
    lines.append("    }")
    lines.append("")

    # encode -> std::array
    lines.append(f"    std::array<uint8_t, PAYLOAD_BYTES> encode() const {{")
    lines.append("        std::array<uint8_t, PAYLOAD_BYTES> out{};")
    for sig in msg.signals:
        if sig.constant:
            raw = resolve_default_raw(sig)
            pack = "detail::pack_be" if sig.byte_order == "big_endian" else "detail::pack_le"
            lines.append(f"        // constant: {sig.name} = {sig.default!r}")
            lines.append(f"        {pack}(out.data(), out.size(), {sig.start_bit}, {sig.bit_length}, {raw}ull);")
        else:
            var = f"this->{sanitize_c_id(sig.name)}"
            raw_expr = _phys_to_raw_call(sig, var)
            pack = "detail::pack_be" if sig.byte_order == "big_endian" else "detail::pack_le"
            lines.append(f"        {{ uint64_t r = {raw_expr};")
            lines.append(f"          {pack}(out.data(), out.size(), {sig.start_bit}, {sig.bit_length}, r); }}")
    lines.append("        return out;")
    lines.append("    }")
    lines.append("")

    # encode with cap for raw buffers
    lines.append(f"    std::size_t encode_to(uint8_t* data, std::size_t cap) const {{")
    lines.append("        if (cap < PAYLOAD_BYTES) return 0;")
    lines.append("        auto a = encode();")
    lines.append("        std::memcpy(data, a.data(), PAYLOAD_BYTES);")
    lines.append("        return PAYLOAD_BYTES;")
    lines.append("    }")
    lines.append("")

    # decode
    lines.append(f"    static std::optional<{cls}> decode(const uint8_t* data, std::size_t len) {{")
    lines.append("        if (len < PAYLOAD_BYTES) return std::nullopt;")
    if not fields:
        lines.append("        (void)data;")
    lines.append(f"        {cls} m;")
    for sig in msg.signals:
        if sig.constant:
            continue
        name = sanitize_c_id(sig.name)
        ext = "detail::ext_be" if sig.byte_order == "big_endian" else "detail::ext_le"
        ftype = physical_field_type_c(sig)
        val = _raw_to_phys_call(sig, "r")
        lines.append(f"        {{ uint64_t r = {ext}(data, len, {sig.start_bit}, {sig.bit_length});")
        lines.append(f"          m.{name} = static_cast<{ftype}>({val}); }}")
    lines.append("        return m;")
    lines.append("    }")
    lines.append("")
    lines.append(f"    static std::optional<{cls}> decode(const std::array<uint8_t, PAYLOAD_BYTES>& a) {{")
    lines.append("        return decode(a.data(), a.size());")
    lines.append("    }")
    lines.append("")

    if has_broadcast:
        n = msg.node_count
        seg = byte_count
        total = n * seg
        lines.append(f"    static constexpr std::size_t BROADCAST_BYTES = {total};")
        lines.append(f"    static constexpr uint32_t broadcast_id() noexcept {{")
        lines.append(f"        return BASE_ID + BROADCAST_NODE_ID * NODE_ID_OFFSET;")
        lines.append("    }")
        lines.append("")
        lines.append(f"    static std::array<uint8_t, BROADCAST_BYTES> encode_broadcast(const std::array<{cls}, {n}>& nodes) {{")
        lines.append("        std::array<uint8_t, BROADCAST_BYTES> out{};")
        lines.append(f"        for (std::size_t i = 0; i < {n}; ++i) {{")
        lines.append(f"            auto p = nodes[i].encode();")
        lines.append(f"            std::memcpy(out.data() + i * PAYLOAD_BYTES, p.data(), PAYLOAD_BYTES);")
        lines.append("        }")
        lines.append("        return out;")
        lines.append("    }")
        lines.append("")
        lines.append(f"    static std::optional<std::array<{cls}, {n}>> decode_broadcast(const uint8_t* data, std::size_t len) {{")
        lines.append("        if (len < BROADCAST_BYTES) return std::nullopt;")
        lines.append(f"        std::array<{cls}, {n}> out{{}};")
        lines.append(f"        for (std::size_t i = 0; i < {n}; ++i) {{")
        lines.append(f"            auto m = decode(data + i * PAYLOAD_BYTES, PAYLOAD_BYTES);")
        lines.append("            if (!m) return std::nullopt;")
        lines.append("            out[i] = *m;")
        lines.append(f"            out[i].node_id = NODE_ID_START + static_cast<uint32_t>(i);")
        lines.append("        }")
        lines.append("        return out;")
        lines.append("    }")
        lines.append("")

    lines.append("};")
    lines.append("")


def generate_cpp(device: DeviceConfig) -> str:
    ns = _device_ns(device)
    L: list[str] = []
    L.append("// =====================================================================")
    L.append(f"// Auto-generated CAN/CAN-FD codec for device: {device.name}")
    if device.description:
        L.append("//")
        for line in device.description.splitlines():
            L.append(f"// {line}")
    L.append("//")
    L.append("// Generated by canfd-codec. DO NOT EDIT BY HAND.")
    L.append("// Regenerate with: canfd-codec -c <config> genlib --lang cpp")
    L.append("// =====================================================================")
    L.append("#pragma once")
    L.append("")
    L.append("#include <array>")
    L.append("#include <cstdint>")
    L.append("#include <cstddef>")
    L.append("#include <cstring>")
    L.append("#include <optional>")
    L.append("")
    L.append(f"namespace {ns} {{")
    L.append("")
    L.append(f"inline constexpr const char* DEVICE_NAME = \"{device.name}\";")
    L.append(f"inline constexpr bool DEVICE_FD = {'true' if device.fd else 'false'};")
    L.append(f"inline constexpr uint32_t DEVICE_BITRATE = {device.bitrate}u;")
    if device.fd:
        L.append(f"inline constexpr uint32_t DEVICE_DATA_BITRATE = {device.data_bitrate}u;")
    L.append("")
    L.append(_runtime_helpers())
    L.append("")
    L.append("// ===== Enum / bitfield constants =====")
    for msg in device.messages:
        for sig in msg.signals:
            if is_enum(sig):
                _emit_enum(sig, msg, L)
            elif is_bitfield(sig):
                _emit_bitfield(sig, msg, L)
    L.append("")
    L.append("// ===== Message types =====")
    for msg in device.messages:
        _emit_struct(msg, L)
    L.append(f"}} // namespace {ns}")
    L.append("")
    return "\n".join(L)
