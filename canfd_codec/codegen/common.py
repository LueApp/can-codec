"""
Shared helpers for code generators.

These utilities are language-agnostic: they expose the geometry of a Signal
(raw range, fitting integer width, default value coercion) and produce safe
identifiers for the various target languages.
"""

import re
from ..codec import Signal, Message


# ---------------------------------------------------------------------------
# Identifier sanitization
# ---------------------------------------------------------------------------
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def sanitize_c_id(name: str) -> str:
    """Strip a name down to a valid C identifier. Leading digit gets prefix."""
    s = re.sub(r"[^a-zA-Z0-9_]", "_", name.strip())
    if not s:
        return "_"
    if s[0].isdigit():
        s = "_" + s
    return s


_RUST_KEYWORDS = {
    "as", "async", "await", "break", "const", "continue", "crate", "dyn",
    "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
    "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
    "self", "Self", "static", "struct", "super", "trait", "true", "type",
    "union", "unsafe", "use", "where", "while", "abstract", "become", "box",
    "do", "final", "macro", "override", "priv", "typeof", "unsized", "virtual",
    "yield", "try", "gen",
}
_RUST_NON_RAW_IDENTIFIERS = {"crate", "self", "Self", "super"}


def sanitize_rust_id(name: str) -> str:
    """Return a Rust field identifier, escaping reserved words when possible."""
    s = sanitize_c_id(name)
    if s in _RUST_NON_RAW_IDENTIFIERS:
        return "_" + s
    if s in _RUST_KEYWORDS:
        return "r#" + s
    return s


def to_snake_case(name: str) -> str:
    """PascalCase / camelCase -> snake_case, also sanitizes."""
    s = sanitize_c_id(name)
    s = _CAMEL_BOUNDARY.sub("_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s.lower() if s else "_"


def to_pascal_case(name: str) -> str:
    """snake_case / camelCase -> PascalCase."""
    parts = re.split(r"[^a-zA-Z0-9]", name)
    out = []
    for p in parts:
        if not p:
            continue
        # split mixed-case parts further (e.g. "MITControl" -> ["MIT", "Control"])
        sub = _CAMEL_BOUNDARY.sub(" ", p).split()
        for s in sub:
            out.append(s[:1].upper() + s[1:].lower() if s else "")
    result = "".join(out)
    if not result:
        return "Unnamed"
    if result[0].isdigit():
        result = "M" + result
    return result


def to_upper_snake(name: str) -> str:
    """For C #defines and Rust constants."""
    return to_snake_case(name).upper()


# ---------------------------------------------------------------------------
# Signal type analysis
# ---------------------------------------------------------------------------
def signal_max_raw(sig: Signal) -> int:
    """Largest raw unsigned value that fits in this signal."""
    return (1 << sig.bit_length) - 1


def fitting_uint_bits(bit_length: int) -> int:
    """Smallest standard uint width that fits the signal (8/16/32/64)."""
    for w in (8, 16, 32, 64):
        if bit_length <= w:
            return w
    raise ValueError(f"bit_length {bit_length} too large for stdint type")


def c_uint_type(bit_length: int) -> str:
    return f"uint{fitting_uint_bits(bit_length)}_t"


def c_int_type(bit_length: int) -> str:
    return f"int{fitting_uint_bits(bit_length)}_t"


def rust_uint_type(bit_length: int) -> str:
    return f"u{fitting_uint_bits(bit_length)}"


def rust_int_type(bit_length: int) -> str:
    return f"i{fitting_uint_bits(bit_length)}"


def is_float(sig: Signal) -> bool:
    return sig.value_type in ("float32", "float64")


def is_signed(sig: Signal) -> bool:
    return sig.value_type == "signed"


def is_enum(sig: Signal) -> bool:
    return bool(sig.enum_map)


def is_bitfield(sig: Signal) -> bool:
    return bool(sig.bitfield_map)


def is_identity_integer(sig: Signal) -> bool:
    """True when the public field can map to raw bits without floating point."""
    return (
        not is_float(sig)
        and sig.scale == 1.0
        and sig.offset == 0.0
        and not sig.unit
    )


def physical_field_type_c(sig: Signal) -> str:
    """Return the C/C++ field type for the user-facing struct."""
    if is_bitfield(sig):
        return c_uint_type(sig.bit_length)
    if is_enum(sig):
        return c_uint_type(sig.bit_length)
    if sig.value_type == "float32":
        return "float"
    if sig.value_type == "float64":
        return "double"
    if sig.scale != 1.0 or sig.offset != 0.0 or sig.unit:
        return "double"
    return c_int_type(sig.bit_length) if is_signed(sig) else c_uint_type(sig.bit_length)


def physical_field_type_rust(sig: Signal) -> str:
    if is_bitfield(sig):
        return rust_uint_type(sig.bit_length)
    if is_enum(sig):
        return rust_uint_type(sig.bit_length)
    if sig.value_type == "float32":
        return "f32"
    if sig.value_type == "float64":
        return "f64"
    if sig.scale != 1.0 or sig.offset != 0.0 or sig.unit:
        return "f64"
    return rust_int_type(sig.bit_length) if is_signed(sig) else rust_uint_type(sig.bit_length)


def physical_field_type_py(sig: Signal) -> str:
    if is_bitfield(sig) or is_enum(sig):
        return "int"
    if is_float(sig):
        return "float"
    if sig.scale != 1.0 or sig.offset != 0.0:
        return "float"
    return "int"


# ---------------------------------------------------------------------------
# Default value resolution
# ---------------------------------------------------------------------------
def resolve_default_raw(sig: Signal) -> int:
    """Compute the raw integer value to pack for a default-bearing signal."""
    if sig.default is None:
        return 0
    val = sig.default

    if is_bitfield(sig) and isinstance(val, dict):
        raw = 0
        rev = {v.lower(): k for k, v in sig.bitfield_map.items()}
        for n, on in val.items():
            b = rev.get(n.lower())
            if b is not None and on:
                raw |= 1 << b
        return raw

    if is_enum(sig) and isinstance(val, str):
        for k, v in sig.enum_map.items():
            if v.lower() == val.lower():
                return k
        return 0

    try:
        fval = float(val)
    except (TypeError, ValueError):
        return 0

    if sig.value_type == "float32":
        import struct
        return struct.unpack("<I", struct.pack("<f", fval))[0]
    if sig.value_type == "float64":
        import struct
        return struct.unpack("<Q", struct.pack("<d", fval))[0]

    raw = int((fval - sig.offset) / sig.scale) if sig.scale != 0 else int(fval)
    if is_signed(sig) and raw < 0:
        raw += 1 << sig.bit_length
    raw &= signal_max_raw(sig)
    return raw


def resolve_default_physical(sig: Signal):
    """The default expressed as a physical value (for struct initializers)."""
    if sig.default is None:
        return None
    if is_bitfield(sig):
        return resolve_default_raw(sig)
    if is_enum(sig):
        return resolve_default_raw(sig)
    try:
        return float(sig.default)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Filtering "user-facing" signals
# ---------------------------------------------------------------------------
def user_signals(msg: Message) -> list[Signal]:
    """Signals the user must (or can) provide values for. Excludes constant-only."""
    return [s for s in msg.signals if not s.constant]


def total_payload_bytes(msg: Message) -> int:
    from ..codec import dlc_to_bytes
    return dlc_to_bytes(msg.dlc)


__all__ = [
    "sanitize_c_id",
    "sanitize_rust_id",
    "to_snake_case",
    "to_pascal_case",
    "to_upper_snake",
    "signal_max_raw",
    "fitting_uint_bits",
    "c_uint_type",
    "c_int_type",
    "rust_uint_type",
    "rust_int_type",
    "is_float",
    "is_signed",
    "is_enum",
    "is_bitfield",
    "is_identity_integer",
    "physical_field_type_c",
    "physical_field_type_rust",
    "physical_field_type_py",
    "resolve_default_raw",
    "resolve_default_physical",
    "user_signals",
    "total_payload_bytes",
]
