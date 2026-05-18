"""
Code generation for standalone device-specific codec libraries.

Given a DeviceConfig parsed from a YAML file, each generator emits a single
self-contained source file in the target language. The generated file has
zero dependencies on this package and can be dropped into any project.

Supported targets:
  - python  -> .py    (works with Python 3.7+)
  - c       -> .h     (header-only, C99)
  - cpp     -> .hpp   (header-only, C++17)
  - rust    -> .rs    (single-file module, no_std-compatible if floats unused)
"""

from ..codec import DeviceConfig
from .python_gen import generate_python
from .c_gen import generate_c
from .cpp_gen import generate_cpp
from .rust_gen import generate_rust


GENERATORS = {
    "python": generate_python,
    "py": generate_python,
    "python3": generate_python,
    "c": generate_c,
    "cpp": generate_cpp,
    "c++": generate_cpp,
    "rust": generate_rust,
    "rs": generate_rust,
}

EXTENSIONS = {
    "python": ".py",
    "py": ".py",
    "python3": ".py",
    "c": ".h",
    "cpp": ".hpp",
    "c++": ".hpp",
    "rust": ".rs",
    "rs": ".rs",
}


def generate(lang: str, device: DeviceConfig) -> str:
    """Generate library source for the given language."""
    lang = lang.lower()
    if lang not in GENERATORS:
        raise ValueError(
            f"Unknown language '{lang}'. Supported: {sorted(set(GENERATORS.keys()))}"
        )
    return GENERATORS[lang](device)


def extension_for(lang: str) -> str:
    """Return the file extension for a target language."""
    lang = lang.lower()
    if lang not in EXTENSIONS:
        raise ValueError(f"Unknown language '{lang}'")
    return EXTENSIONS[lang]


__all__ = ["generate", "extension_for", "GENERATORS", "EXTENSIONS"]
