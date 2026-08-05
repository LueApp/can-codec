"""Rust generator (single-file module)."""

from ..codec import DeviceConfig, Message, Signal
from .common import (
    sanitize_rust_id, to_snake_case, to_pascal_case, to_upper_snake,
    signal_max_raw, rust_uint_type, rust_int_type,
    is_float, is_signed, is_enum, is_bitfield, is_identity_integer,
    physical_field_type_rust, resolve_default_raw, resolve_default_physical,
    user_signals, total_payload_bytes,
)


def _runtime_helpers() -> str:
    return r'''
mod detail {
    #[inline]
    pub fn ext_le(data: &[u8], start: usize, length: usize) -> u64 {
        let mut v: u64 = 0;
        for i in 0..length {
            let bi = (start + i) >> 3;
            if bi < data.len() && (data[bi] & (1u8 << ((start + i) & 7))) != 0 {
                v |= 1u64 << i;
            }
        }
        v
    }

    #[inline]
    pub fn ext_be(data: &[u8], start: usize, length: usize) -> u64 {
        let mut v: u64 = 0;
        for i in 0..length {
            let bp = start + i;
            let bi = bp >> 3;
            if bi < data.len() && (data[bi] & (1u8 << (7 - (bp & 7)))) != 0 {
                v |= 1u64 << (length - 1 - i);
            }
        }
        v
    }

    #[inline]
    pub fn pack_le(data: &mut [u8], start: usize, length: usize, value: u64) {
        for i in 0..length {
            let bi = (start + i) >> 3;
            if bi >= data.len() { break; }
            let b = (start + i) & 7;
            if (value & (1u64 << i)) != 0 { data[bi] |=  1u8 << b; }
            else                          { data[bi] &= !(1u8 << b); }
        }
    }

    #[inline]
    pub fn pack_be(data: &mut [u8], start: usize, length: usize, value: u64) {
        for i in 0..length {
            let bp = start + i;
            let bi = bp >> 3;
            if bi >= data.len() { break; }
            let b = 7 - (bp & 7);
            if (value & (1u64 << (length - 1 - i))) != 0 { data[bi] |=  1u8 << b; }
            else                                         { data[bi] &= !(1u8 << b); }
        }
    }

    #[inline]
    pub fn sign_extend(raw: u64, length: usize) -> i64 {
        if length >= 64 { return raw as i64; }
        let sign = 1u64 << (length - 1);
        if (raw & sign) != 0 {
            (raw | (!0u64 << length)) as i64
        } else {
            raw as i64
        }
    }

    #[inline]
    pub fn f32_to_u32(v: f32) -> u32 { v.to_bits() }
    #[inline]
    pub fn u32_to_f32(r: u32) -> f32 { f32::from_bits(r) }
    #[inline]
    pub fn f64_to_u64(v: f64) -> u64 { v.to_bits() }
    #[inline]
    pub fn u64_to_f64(r: u64) -> f64 { f64::from_bits(r) }

    #[inline]
    pub fn clamp_u(raw: i64, length: usize) -> u64 {
        let maxv: i64 = if length >= 64 { i64::MAX } else { ((1u64 << length) - 1) as i64 };
        if raw < 0 { 0 } else if raw > maxv { maxv as u64 } else { raw as u64 }
    }

    #[inline]
    pub fn phys_to_raw_signed(v: f64, scale: f64, offset: f64, length: usize) -> u64 {
        let r = if scale != 0.0 { (v - offset) / scale } else { 0.0 };
        let mut raw = r as i64;
        if raw < 0 { raw += 1i64 << length; }
        clamp_u(raw, length)
    }

    #[inline]
    pub fn phys_to_raw_unsigned(v: f64, scale: f64, offset: f64, length: usize) -> u64 {
        let r = if scale != 0.0 { (v - offset) / scale } else { 0.0 };
        clamp_u(r as i64, length)
    }

    #[inline]
    pub fn raw_to_phys_signed(raw: u64, scale: f64, offset: f64, length: usize) -> f64 {
        sign_extend(raw, length) as f64 * scale + offset
    }

    #[inline]
    pub fn raw_to_phys_unsigned(raw: u64, scale: f64, offset: f64) -> f64 {
        raw as f64 * scale + offset
    }
}
'''


def _emit_enum_mod(sig: Signal, msg: Message, lines: list[str]):
    mod_name = f"{to_snake_case(msg.name)}_{to_snake_case(sig.name)}"
    lines.append(f"/// Enum constants for `{msg.name}.{sig.name}`.")
    lines.append(f"pub mod {mod_name} {{")
    for raw_val, name in sorted(sig.enum_map.items()):
        const_name = to_upper_snake(name)
        if const_name and const_name[0].isdigit():
            const_name = "_" + const_name
        lines.append(f"    pub const {const_name}: u32 = {raw_val};")
    lines.append("}")
    lines.append("")


def _emit_bitfield_mod(sig: Signal, msg: Message, lines: list[str]):
    mod_name = f"{to_snake_case(msg.name)}_{to_snake_case(sig.name)}_flags"
    lines.append(f"/// Bit flags for `{msg.name}.{sig.name}`.")
    lines.append(f"pub mod {mod_name} {{")
    for bit_pos, name in sorted(sig.bitfield_map.items()):
        const_name = to_upper_snake(name)
        if const_name and const_name[0].isdigit():
            const_name = "_" + const_name
        lines.append(f"    pub const {const_name}: u32 = 1u32 << {bit_pos};")
    lines.append("}")
    lines.append("")


def _phys_to_raw_call(sig: Signal, var: str) -> str:
    mask = signal_max_raw(sig)
    if is_bitfield(sig) or is_enum(sig):
        return f"({var} as u64) & {mask}u64"
    if sig.value_type == "float32":
        return f"detail::f32_to_u32({var} as f32) as u64"
    if sig.value_type == "float64":
        return f"detail::f64_to_u64({var} as f64)"
    if is_identity_integer(sig):
        return f"({var} as u64) & {mask}u64"
    fn = "detail::phys_to_raw_signed" if is_signed(sig) else "detail::phys_to_raw_unsigned"
    return f"{fn}({var} as f64, {sig.scale}f64, {sig.offset}f64, {sig.bit_length})"


def _raw_to_phys_call(sig: Signal, raw_var: str) -> str:
    if is_bitfield(sig) or is_enum(sig):
        return raw_var
    if sig.value_type == "float32":
        return f"detail::u32_to_f32({raw_var} as u32)"
    if sig.value_type == "float64":
        return f"detail::u64_to_f64({raw_var})"
    if is_identity_integer(sig):
        return f"detail::sign_extend({raw_var}, {sig.bit_length})" if is_signed(sig) else raw_var
    if is_signed(sig):
        return f"detail::raw_to_phys_signed({raw_var}, {sig.scale}f64, {sig.offset}f64, {sig.bit_length})"
    return f"detail::raw_to_phys_unsigned({raw_var}, {sig.scale}f64, {sig.offset}f64)"


def _emit_struct(msg: Message, lines: list[str]):
    name = to_pascal_case(msg.name)
    byte_count = total_payload_bytes(msg)
    fields = user_signals(msg)
    is_multi = msg.node_count > 1
    has_broadcast = msg.broadcast_node_id is not None

    desc = (msg.description or "").strip().replace("\n", " ")
    if desc:
        lines.append(f"/// {desc}")
    lines.append(f"/// CAN id = 0x{msg.id:X}, dlc = {msg.dlc}")
    lines.append("#[derive(Debug, Clone, Copy, PartialEq)]")
    lines.append(f"pub struct {name} {{")
    for sig in fields:
        ftype = physical_field_type_rust(sig)
        unit = f"  // {sig.unit}" if sig.unit else ""
        fname = sanitize_rust_id(sig.name)
        lines.append(f"    pub {fname}: {ftype},{unit}")
    if is_multi:
        lines.append("    pub node_id: u32,")
    lines.append("}")
    lines.append("")

    # Default impl
    lines.append(f"impl Default for {name} {{")
    lines.append("    fn default() -> Self {")
    lines.append("        Self {")
    for sig in fields:
        ftype = physical_field_type_rust(sig)
        fname = sanitize_rust_id(sig.name)
        d = resolve_default_physical(sig)
        if d is None:
            if ftype.startswith("f"):
                default = "0.0"
            else:
                default = "0"
        elif ftype.startswith("f"):
            default = f"{float(d):.17g}f64" if ftype == "f64" else f"{float(d):.17g}f32"
        else:
            default = str(int(d))
        lines.append(f"            {fname}: {default},")
    if is_multi:
        lines.append(f"            node_id: {msg.node_id_start},")
    lines.append("        }")
    lines.append("    }")
    lines.append("}")
    lines.append("")

    # impl block with constants and methods
    lines.append(f"impl {name} {{")
    lines.append(f"    pub const BASE_ID: u32 = 0x{msg.id:X};")
    lines.append(f"    pub const DLC: usize = {msg.dlc};")
    lines.append(f"    pub const PAYLOAD_BYTES: usize = {byte_count};")
    lines.append(f"    pub const NODE_COUNT: u32 = {msg.node_count};")
    lines.append(f"    pub const NODE_ID_OFFSET: u32 = {msg.node_id_offset};")
    lines.append(f"    pub const NODE_ID_START: u32 = {msg.node_id_start};")
    if msg.crc_extra is not None:
        lines.append(f"    pub const CRC_EXTRA: u8 = {msg.crc_extra};")
    if has_broadcast:
        lines.append(f"    pub const BROADCAST_NODE_ID: u32 = 0x{msg.broadcast_node_id:X};")
        lines.append(f"    pub const BROADCAST_BYTES: usize = {byte_count * msg.node_count};")
    lines.append("")

    # id_for_node
    lines.append("    #[inline]")
    lines.append("    pub const fn id_for_node(nid: u32) -> u32 {")
    if is_multi:
        lines.append("        Self::BASE_ID + nid * Self::NODE_ID_OFFSET")
    else:
        lines.append("        let _ = nid;")
        lines.append("        Self::BASE_ID")
    lines.append("    }")
    lines.append("")

    # node_for_id
    lines.append("    pub fn node_for_id(can_id: u32) -> Option<u32> {")
    if not is_multi:
        lines.append("        if can_id == Self::BASE_ID { Some(Self::NODE_ID_START) } else { None }")
    else:
        lines.append("        let off = can_id as i64 - Self::BASE_ID as i64;")
        lines.append("        if Self::NODE_ID_OFFSET == 0 {")
        lines.append("            return if off == 0 { Some(Self::NODE_ID_START) } else { None };")
        lines.append("        }")
        lines.append("        if off % Self::NODE_ID_OFFSET as i64 != 0 { return None; }")
        lines.append("        let nid = off / Self::NODE_ID_OFFSET as i64;")
        if has_broadcast:
            lines.append("        if nid as u32 == Self::BROADCAST_NODE_ID { return Some(nid as u32); }")
        lines.append("        let max = (Self::NODE_ID_START + Self::NODE_COUNT - 1) as i64;")
        lines.append("        if nid >= Self::NODE_ID_START as i64 && nid <= max {")
        lines.append("            Some(nid as u32)")
        lines.append("        } else {")
        lines.append("            None")
        lines.append("        }")
    lines.append("    }")
    lines.append("")

    # encode
    lines.append(f"    pub fn encode(&self) -> [u8; {byte_count}] {{")
    lines.append(f"        let mut data = [0u8; {byte_count}];")
    for sig in msg.signals:
        if sig.constant:
            raw = resolve_default_raw(sig)
            pack = "detail::pack_be" if sig.byte_order == "big_endian" else "detail::pack_le"
            lines.append(f"        // constant: {sig.name}")
            lines.append(f"        {pack}(&mut data, {sig.start_bit}, {sig.bit_length}, {raw}u64);")
        else:
            var = f"self.{sanitize_rust_id(sig.name)}"
            raw_expr = _phys_to_raw_call(sig, var)
            pack = "detail::pack_be" if sig.byte_order == "big_endian" else "detail::pack_le"
            lines.append(f"        {{ let r = {raw_expr};")
            lines.append(f"          {pack}(&mut data, {sig.start_bit}, {sig.bit_length}, r); }}")
    lines.append("        data")
    lines.append("    }")
    lines.append("")

    # decode
    lines.append("    pub fn decode(data: &[u8]) -> Option<Self> {")
    lines.append(f"        if data.len() < {byte_count} {{ return None; }}")
    non_const = [s for s in msg.signals if not s.constant]
    mut_keyword = "mut " if non_const else ""
    lines.append(f"        let {mut_keyword}m = Self::default();")
    for sig in msg.signals:
        if sig.constant:
            continue
        fname = sanitize_rust_id(sig.name)
        ext = "detail::ext_be" if sig.byte_order == "big_endian" else "detail::ext_le"
        ftype = physical_field_type_rust(sig)
        val = _raw_to_phys_call(sig, "r")
        lines.append(f"        {{ let r = {ext}(data, {sig.start_bit}, {sig.bit_length});")
        lines.append(f"          m.{fname} = ({val}) as {ftype}; }}")
    lines.append("        Some(m)")
    lines.append("    }")
    lines.append("")

    # broadcast helpers
    if has_broadcast:
        n = msg.node_count
        seg = byte_count
        total = n * seg
        lines.append(f"    pub const fn broadcast_id() -> u32 {{")
        lines.append(f"        Self::BASE_ID + Self::BROADCAST_NODE_ID * Self::NODE_ID_OFFSET")
        lines.append("    }")
        lines.append("")
        lines.append(f"    pub fn encode_broadcast(nodes: &[Self; {n}]) -> [u8; {total}] {{")
        lines.append(f"        let mut data = [0u8; {total}];")
        lines.append(f"        for i in 0..{n} {{")
        lines.append(f"            let p = nodes[i].encode();")
        lines.append(f"            data[i*{seg}..(i+1)*{seg}].copy_from_slice(&p);")
        lines.append("        }")
        lines.append("        data")
        lines.append("    }")
        lines.append("")
        lines.append(f"    pub fn decode_broadcast(data: &[u8]) -> Option<[Self; {n}]> {{")
        lines.append(f"        if data.len() < {total} {{ return None; }}")
        lines.append(f"        let mut out = [Self::default(); {n}];")
        lines.append(f"        for i in 0..{n} {{")
        mut_kw = "mut " if is_multi else ""
        lines.append(f"            let {mut_kw}m = Self::decode(&data[i*{seg}..(i+1)*{seg}])?;")
        if is_multi:
            lines.append("            m.node_id = Self::NODE_ID_START + i as u32;")
        lines.append("            out[i] = m;")
        lines.append("        }")
        lines.append("        Some(out)")
        lines.append("    }")
        lines.append("")

    lines.append("}")
    lines.append("")


def _emit_frame_enum(device: DeviceConfig, lines: list[str]):
    lines.append("/// Decoded frame from any known message of this device.")
    lines.append("#[derive(Debug, Clone)]")
    lines.append("pub enum Frame {")
    for msg in device.messages:
        name = to_pascal_case(msg.name)
        lines.append(f"    {name}({name}),")
        if msg.broadcast_node_id is not None:
            lines.append(f"    {name}Broadcast([{name}; {msg.node_count}]),")
    lines.append("}")
    lines.append("")
    lines.append("/// Dispatch a CAN frame to the correct message decoder.")
    lines.append("pub fn decode_frame(can_id: u32, data: &[u8]) -> Option<Frame> {")
    for msg in device.messages:
        name = to_pascal_case(msg.name)
        lines.append(f"    if let Some(nid) = {name}::node_for_id(can_id) {{")
        if msg.broadcast_node_id is not None:
            lines.append(f"        if nid == {name}::BROADCAST_NODE_ID {{")
            lines.append(f"            if let Some(arr) = {name}::decode_broadcast(data) {{")
            lines.append(f"                return Some(Frame::{name}Broadcast(arr));")
            lines.append("            }")
            lines.append("        }")
        if msg.node_count > 1:
            lines.append(f"        if let Some(mut m) = {name}::decode(data) {{")
            lines.append("            m.node_id = nid;")
        else:
            lines.append(f"        if let Some(m) = {name}::decode(data) {{")
            lines.append("            let _ = nid;")
        lines.append(f"            return Some(Frame::{name}(m));")
        lines.append("        }")
        lines.append("    }")
    lines.append("    None")
    lines.append("}")
    lines.append("")


def generate_rust(device: DeviceConfig) -> str:
    L: list[str] = []
    L.append("//! Auto-generated CAN/CAN-FD codec for device: " + device.name)
    if device.description:
        L.append("//!")
        for line in device.description.splitlines():
            L.append(f"//! {line}")
    L.append("//!")
    L.append("//! Generated by canfd-codec. DO NOT EDIT BY HAND.")
    L.append("//! Regenerate with: `canfd-codec -c <config> genlib --lang rust`.")
    L.append("")
    L.append("#![allow(dead_code, non_snake_case, non_camel_case_types, clippy::all)]")
    L.append("")
    L.append(f"pub const DEVICE_NAME: &str = \"{device.name}\";")
    if not device.mavlink:
        L.append(f"pub const DEVICE_FD: bool = {'true' if device.fd else 'false'};")
        L.append(f"pub const DEVICE_BITRATE: u32 = {device.bitrate};")
        if device.fd:
            L.append(f"pub const DEVICE_DATA_BITRATE: u32 = {device.data_bitrate};")
    L.append("")
    L.append(_runtime_helpers())
    L.append("")
    L.append("// ===== Enum / bitfield constants =====")
    for msg in device.messages:
        for sig in msg.signals:
            if is_enum(sig):
                _emit_enum_mod(sig, msg, L)
            elif is_bitfield(sig):
                _emit_bitfield_mod(sig, msg, L)
    L.append("")
    L.append("// ===== Message types =====")
    for msg in device.messages:
        _emit_struct(msg, L)
    L.append("// ===== Top-level dispatch =====")
    _emit_frame_enum(device, L)
    return "\n".join(L)
