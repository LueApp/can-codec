"""
Live CAN bus monitor with real-time decoding.

Uses python-can to interface with real or virtual CAN buses and decodes
incoming frames in real-time using the codec engine.

Supports:
  - Real-time frame decode with color-coded output
  - Filtering by message ID or name
  - Periodic summary mode (shows latest value of each signal)
  - Logging decoded output to file
"""

import time
import sys
import signal as signal_module
from datetime import datetime
from typing import TextIO

from .codec import Codec, DecodedMessage


# ---------------------------------------------------------------------------
# ANSI color helpers
# ---------------------------------------------------------------------------
class Colors:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    WHITE = "\033[97m"

    @staticmethod
    def disable():
        for attr in ["RESET", "BOLD", "DIM", "RED", "GREEN", "YELLOW",
                      "BLUE", "MAGENTA", "CYAN", "WHITE"]:
            setattr(Colors, attr, "")


# Assign rotating colors to different message IDs
_MSG_COLORS = [Colors.CYAN, Colors.GREEN, Colors.YELLOW,
               Colors.MAGENTA, Colors.BLUE, Colors.WHITE]
_color_map: dict[int, str] = {}


def _get_color(msg_id: int) -> str:
    if msg_id not in _color_map:
        _color_map[msg_id] = _MSG_COLORS[len(_color_map) % len(_MSG_COLORS)]
    return _color_map[msg_id]


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------
def format_frame_line(decoded: DecodedMessage, timestamp: float | None = None) -> str:
    """Format a decoded message as a single colored line."""
    color = _get_color(decoded.msg_id)
    ts = ""
    if timestamp is not None:
        ts = f"{Colors.DIM}{timestamp:12.3f}{Colors.RESET} "

    header = f"{ts}{color}{Colors.BOLD}[0x{decoded.msg_id:03X}]{Colors.RESET} {color}{decoded.name}{Colors.RESET}"
    signals = "  ".join(
        f"{Colors.DIM}{s.name}={Colors.RESET}{s.display_value()}"
        for s in decoded.signals
    )
    return f"{header}  {signals}"


def format_frame_detail(decoded: DecodedMessage, timestamp: float | None = None) -> str:
    """Format a decoded message in detailed multi-line format."""
    color = _get_color(decoded.msg_id)
    lines = []

    ts = f" @ {timestamp:.3f}s" if timestamp is not None else ""
    raw_hex = decoded.raw_data.hex(" ").upper()
    lines.append(
        f"{color}{Colors.BOLD}[0x{decoded.msg_id:03X}] {decoded.name}{Colors.RESET}"
        f"{Colors.DIM}{ts}  [{raw_hex}]{Colors.RESET}"
    )
    for s in decoded.signals:
        val_str = s.display_value()
        lines.append(
            f"  {Colors.DIM}{s.name}:{Colors.RESET} {val_str}"
            f"  {Colors.DIM}(raw=0x{s.raw_value:X}){Colors.RESET}"
        )
    return "\n".join(lines)


def format_unknown_frame(msg_id: int, data: bytes, timestamp: float | None = None) -> str:
    """Format an unknown (un-decodable) CAN frame."""
    ts = ""
    if timestamp is not None:
        ts = f"{Colors.DIM}{timestamp:12.3f}{Colors.RESET} "
    raw_hex = data.hex(" ").upper()
    return f"{ts}{Colors.RED}[0x{msg_id:03X}] UNKNOWN  [{raw_hex}]{Colors.RESET}"


# ---------------------------------------------------------------------------
# Monitor class
# ---------------------------------------------------------------------------
class Monitor:
    """
    Live CAN bus monitor with real-time decoding.

    Usage:
        codec = Codec("./configs")
        monitor = Monitor(codec, bus="vcan0", interface="socketcan")
        monitor.run()    # blocks until Ctrl-C
    """

    def __init__(
        self,
        codec: Codec,
        bus: str = "vcan0",
        interface: str = "socketcan",
        fd: bool = True,
        bitrate: int | None = None,
        data_bitrate: int | None = None,
        filter_ids: list[int] | None = None,
        detailed: bool = False,
        show_unknown: bool = True,
        log_file: TextIO | None = None,
    ):
        self.codec = codec
        self.bus = bus
        self.interface = interface
        self.fd = fd
        self.bitrate = bitrate
        self.data_bitrate = data_bitrate
        self.filter_ids = set(filter_ids) if filter_ids else None
        self.detailed = detailed
        self.show_unknown = show_unknown
        self.log_file = log_file
        self._running = False
        self._frame_count = 0
        self._start_time: float | None = None

    def run(self):
        """Start monitoring. Blocks until Ctrl-C."""
        try:
            import can
        except ImportError:
            print(
                f"{Colors.RED}Error: python-can is not installed.{Colors.RESET}\n"
                f"Install it with: pip install python-can\n"
                f"For virtual CAN testing, also run:\n"
                f"  sudo modprobe vcan\n"
                f"  sudo ip link add dev vcan0 type vcan\n"
                f"  sudo ip link set up vcan0",
                file=sys.stderr,
            )
            sys.exit(1)

        print(f"{Colors.BOLD}CAN FD Monitor{Colors.RESET}")
        print(f"  Bus:       {self.bus} ({self.interface})")
        print(f"  FD mode:   {'yes' if self.fd else 'no'}")
        if self.filter_ids:
            ids_str = ", ".join(f"0x{i:03X}" for i in sorted(self.filter_ids))
            print(f"  Filter:    {ids_str}")
        print(f"  Configs:   {len(self.codec.devices)} device(s), "
              f"{sum(len(d.messages) for d in self.codec.devices)} message(s)")
        print(f"\n{Colors.DIM}Press Ctrl-C to stop...{Colors.RESET}\n")

        self._running = True
        self._frame_count = 0
        self._start_time = time.time()

        # Handle Ctrl-C gracefully
        original_handler = signal_module.getsignal(signal_module.SIGINT)
        signal_module.signal(signal_module.SIGINT, self._sigint_handler)

        try:
            bus_config: dict = {"interface": self.interface, "channel": self.bus}
            if self.fd:
                bus_config["fd"] = True
            if self.bitrate is not None:
                bus_config["bitrate"] = self.bitrate

            with can.Bus(**bus_config) as bus_conn:
                if self.data_bitrate is not None and hasattr(bus_conn, "set_bitrate"):
                    bus_conn.set_bitrate(self.bitrate, self.data_bitrate)
                while self._running:
                    msg = bus_conn.recv(timeout=1.0)
                    if msg is not None:
                        self._process_frame(msg)

        except OSError as e:
            print(f"\n{Colors.RED}Bus error: {e}{Colors.RESET}", file=sys.stderr)
            print(
                f"Make sure '{self.bus}' is available. For virtual CAN:\n"
                f"  sudo modprobe vcan\n"
                f"  sudo ip link add dev {self.bus} type vcan\n"
                f"  sudo ip link set up {self.bus}",
                file=sys.stderr,
            )
        finally:
            signal_module.signal(signal_module.SIGINT, original_handler)
            elapsed = time.time() - self._start_time if self._start_time else 0
            print(f"\n{Colors.DIM}--- {self._frame_count} frames in {elapsed:.1f}s ---{Colors.RESET}")

    def _sigint_handler(self, signum, frame):
        self._running = False

    def _process_frame(self, msg):
        """Process a single CAN frame."""
        # Apply ID filter
        if self.filter_ids and msg.arbitration_id not in self.filter_ids:
            return

        self._frame_count += 1
        ts = msg.timestamp - self._start_time if self._start_time else msg.timestamp

        decoded = self.codec.decode(msg.arbitration_id, bytes(msg.data))

        if decoded is not None:
            if self.detailed:
                output = format_frame_detail(decoded, ts)
            else:
                output = format_frame_line(decoded, ts)
        elif self.show_unknown:
            output = format_unknown_frame(msg.arbitration_id, bytes(msg.data), ts)
        else:
            return

        print(output)

        if self.log_file:
            # Strip ANSI codes for log file
            import re
            clean = re.sub(r"\033\[[0-9;]*m", "", output)
            self.log_file.write(clean + "\n")
            self.log_file.flush()


# ---------------------------------------------------------------------------
# Summary monitor (shows latest values, refreshes in place)
# ---------------------------------------------------------------------------
class SummaryMonitor(Monitor):
    """
    Variant that shows a live-updating summary table instead of scrolling lines.
    Refreshes in-place showing the latest value of every known signal.
    """

    def __init__(self, *args, refresh_rate: float = 0.25, **kwargs):
        super().__init__(*args, **kwargs)
        self.refresh_rate = refresh_rate
        self._latest: dict[int, DecodedMessage] = {}
        self._last_refresh = 0.0

    def _process_frame(self, msg):
        if self.filter_ids and msg.arbitration_id not in self.filter_ids:
            return

        self._frame_count += 1
        decoded = self.codec.decode(msg.arbitration_id, bytes(msg.data))
        if decoded is not None:
            self._latest[msg.arbitration_id] = decoded

        now = time.time()
        if now - self._last_refresh >= self.refresh_rate:
            self._refresh_display()
            self._last_refresh = now

    def _refresh_display(self):
        """Clear screen and redraw the summary table."""
        # Move cursor to top-left and clear
        sys.stdout.write("\033[H\033[J")

        elapsed = time.time() - self._start_time if self._start_time else 0
        print(f"{Colors.BOLD}CAN FD Live Summary{Colors.RESET}  "
              f"{Colors.DIM}({self._frame_count} frames, {elapsed:.0f}s){Colors.RESET}\n")

        if not self._latest:
            print(f"{Colors.DIM}Waiting for frames...{Colors.RESET}")
            return

        for msg_id in sorted(self._latest.keys()):
            decoded = self._latest[msg_id]
            color = _get_color(msg_id)
            print(f"{color}{Colors.BOLD}[0x{msg_id:03X}] {decoded.name}{Colors.RESET}")
            for s in decoded.signals:
                print(f"  {Colors.DIM}{s.name}:{Colors.RESET} {s.display_value()}")
            print()

        sys.stdout.flush()
