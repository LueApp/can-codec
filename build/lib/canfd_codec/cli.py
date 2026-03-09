#!/usr/bin/env python3
"""
canfd-codec: CLI tool for encoding/decoding CAN FD messages.

Usage examples:

  # List all known messages
  canfd-codec list --config ./configs

  # Describe a specific message
  canfd-codec describe SetSpeed --config ./configs

  # Decode a raw CAN frame
  canfd-codec decode 0x201 "E8 03 00 00 A0 86 01 00 30 75 00 00 C0 01 48 05" --config ./configs

  # Encode a command
  canfd-codec encode SetSpeed target_speed=1500 direction=forward enable=on --config ./configs

  # Live monitor
  canfd-codec monitor --config ./configs --bus vcan0

  # Summary monitor
  canfd-codec monitor --config ./configs --bus vcan0 --summary
"""

import argparse
import json
import sys
import os

from .codec import Codec


def _mavlink_crc(data: bytes) -> int:
    """
    Calculate MAVLink X.25 CRC checksum.
    Note: This does not include CRC_EXTRA (message-specific seed).
    """
    crc = 0xFFFF
    for byte in data:
        tmp = byte ^ (crc & 0xFF)
        tmp = (tmp ^ (tmp << 4)) & 0xFF
        crc = (crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)
    return crc & 0xFFFF


def parse_hex_data(hex_str: str) -> bytes:
    """Parse hex string in various formats: '01 02 AB', '0102AB', '01:02:AB'."""
    cleaned = hex_str.replace(":", " ").replace(",", " ").replace("0x", "")
    # Handle both spaced and unspaced
    cleaned = cleaned.strip()
    if " " in cleaned:
        return bytes.fromhex(cleaned.replace(" ", ""))
    else:
        return bytes.fromhex(cleaned)


def parse_signal_values(args: list[str]) -> dict:
    """
    Parse signal=value pairs from command line args.

    Handles:
      target_speed=1500        -> {"target_speed": 1500.0}
      direction=forward        -> {"direction": "forward"}
      enable=on                -> {"enable": "on"}
      fault={ov=true,uv=1}     -> {"fault": {"ov": True, "uv": True}}
      position=[0.0,0.5,1.0]   -> {"position_0": 0.0, "position_1": 0.5, "position_2": 1.0}
    """
    values = {}
    for arg in args:
        if "=" not in arg:
            print(f"Error: Invalid signal format '{arg}'. Expected: name=value",
                  file=sys.stderr)
            sys.exit(1)

        name, val_str = arg.split("=", 1)
        name = name.strip()
        val_str = val_str.strip()

        # Try array format: [val1,val2,val3]
        if val_str.startswith("[") and val_str.endswith("]"):
            inner = val_str[1:-1]
            items = [s.strip() for s in inner.split(",")]
            for i, item in enumerate(items):
                try:
                    if "." in item:
                        values[f"{name}_{i}"] = float(item)
                    else:
                        values[f"{name}_{i}"] = int(item, 0)
                except ValueError:
                    values[f"{name}_{i}"] = item
        # Try bitfield dict format: {flag1=true,flag2=false}
        elif val_str.startswith("{") and val_str.endswith("}"):
            inner = val_str[1:-1]
            flags = {}
            for pair in inner.split(","):
                k, v = pair.split("=", 1)
                flags[k.strip()] = v.strip().lower() in ("true", "1", "yes", "on")
            values[name] = flags
        else:
            # Try numeric
            try:
                if "." in val_str:
                    values[name] = float(val_str)
                else:
                    values[name] = int(val_str, 0)  # supports 0x prefix
            except ValueError:
                # Treat as enum string
                values[name] = val_str

    return values


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------
def cmd_list(args):
    """List all known messages."""
    codec = Codec(args.config)
    messages = codec.list_messages()

    if args.json:
        print(json.dumps(messages, indent=2))
        return

    # Table format
    print(f"{'ID':<8} {'Name':<22} {'Dir':<5} {'DLC':<5} {'FD':<4} {'Device':<25} Description")
    print("-" * 110)
    for m in messages:
        fd = "FD" if m["fd"] else ""
        print(f"{m['id']:<8} {m['name']:<22} {m['direction']:<5} {m['dlc']:<5} {fd:<4} {m['device']:<25} {m['description']}")


def cmd_describe(args):
    """Describe a message in detail."""
    codec = Codec(args.config)
    print(codec.describe_message(args.message))


def cmd_decode(args):
    """Decode a raw CAN frame."""
    codec = Codec(args.config)

    can_id = int(args.id, 0)
    data = parse_hex_data(args.data)

    # MAVLink CAN transport: extract sys_id/comp_id from 29-bit extended CAN ID
    mavlink_info = None
    decoded = None

    if args.mavlink:
        # CAN ID format: 0x10000 | (system_id << 8) | component_id
        if can_id & 0x10000:  # Check MAVLink marker bit
            can_sys_id = (can_id >> 8) & 0xFF
            can_comp_id = can_id & 0xFF
            mavlink_info = {"sys_id": can_sys_id, "comp_id": can_comp_id}

            # Check if this is a full MAVLink v2 frame (starts with 0xFD)
            if len(data) >= 10 and data[0] == 0xFD:
                # MAVLink v2 frame structure:
                # [0] = 0xFD (magic)
                # [1] = payload length
                # [2] = incompat flags
                # [3] = compat flags
                # [4] = sequence
                # [5] = system ID
                # [6] = component ID
                # [7:9] = message ID (24-bit little-endian, but usually 16-bit)
                # [10:10+payload_len] = payload
                # [last 2 bytes] = CRC
                payload_len = data[1]
                msg_sys_id = data[5]
                msg_comp_id = data[6]
                msg_id = data[7] | (data[8] << 8)  # 16-bit message ID
                if len(data) >= 12:  # 3-byte message ID in v2
                    msg_id |= (data[9] << 16)

                # Update mavlink_info with frame info
                mavlink_info["frame_sys_id"] = msg_sys_id
                mavlink_info["frame_comp_id"] = msg_comp_id
                mavlink_info["msg_id"] = msg_id
                mavlink_info["seq"] = data[4]

                # Extract payload (skip header, exclude CRC)
                header_len = 10
                payload = data[header_len:header_len + payload_len]

                # Find message by ID and decode payload
                from .codec import decode as codec_decode
                msg_def = codec._by_id.get(msg_id)
                if msg_def:
                    _, msg = msg_def
                    decoded = codec_decode(msg, bytes(payload), actual_id=can_id)
                else:
                    print(f"Error: Unknown MAVLink message ID {msg_id} (0x{msg_id:X})", file=sys.stderr)
                    print(f"Known message IDs: {', '.join(f'0x{m.id:X}' for d in codec.devices for m in d.messages)}", file=sys.stderr)
                    sys.exit(1)
            else:
                # Raw payload (not a full MAVLink frame) - auto-detect by DLC
                from .codec import decode as codec_decode, dlc_to_bytes
                data_len = len(data)
                candidates = []
                for dev in codec.devices:
                    for msg in dev.messages:
                        if dlc_to_bytes(msg.dlc) == data_len:
                            candidates.append(msg)

                if len(candidates) == 1:
                    decoded = codec_decode(candidates[0], data, actual_id=can_id)
                elif len(candidates) > 1:
                    print(f"Multiple messages match DLC={data_len}:", file=sys.stderr)
                    for msg in candidates:
                        print(f"  - {msg.name} (ID: 0x{msg.id:03X})", file=sys.stderr)
                    print(f"Use: canfd-codec decode 0x{candidates[0].id:03X} '{args.data}'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"Error: No message matches data length {data_len}", file=sys.stderr)
                    sys.exit(1)
        else:
            print(f"Warning: CAN ID 0x{can_id:08X} does not have MAVLink marker bit set", file=sys.stderr)
            decoded = codec.decode(can_id, data)
    else:
        # Standard decode by CAN ID
        decoded = codec.decode(can_id, data)

    if decoded is None:
        print(f"Error: Unknown message ID 0x{can_id:03X}", file=sys.stderr)
        print(f"Known IDs: {', '.join(f'0x{m.id:03X}' for d in codec.devices for m in d.messages)}",
              file=sys.stderr)
        sys.exit(1)

    # Override the displayed ID with actual CAN ID for MAVLink
    if mavlink_info:
        decoded.msg_id = can_id

    if args.json:
        result = {
            "id": f"0x{decoded.msg_id:03X}",
            "name": decoded.name,
            "raw_hex": decoded.raw_data.hex(" "),
            "signals": {},
        }
        if mavlink_info:
            result["mavlink"] = mavlink_info
        if decoded.node_id != 0:
            result["node_id"] = decoded.node_id
            result["base_id"] = f"0x{decoded.base_id:03X}" if decoded.base_id else None
        for s in decoded.signals:
            sig_data = {
                "raw": s.raw_value,
                "value": s.physical_value,
                "display": s.display_value(),
            }
            if s.enum_name:
                sig_data["enum"] = s.enum_name
            if s.bitfield_flags:
                sig_data["flags"] = s.bitfield_flags
            result["signals"][s.name] = sig_data
        print(json.dumps(result, indent=2))
    else:
        if mavlink_info:
            info_parts = [f"sys_id={mavlink_info['sys_id']}", f"comp_id={mavlink_info['comp_id']}"]
            if 'msg_id' in mavlink_info:
                info_parts.append(f"msg_id=0x{mavlink_info['msg_id']:X}")
            if 'seq' in mavlink_info:
                info_parts.append(f"seq={mavlink_info['seq']}")
            print(f"MAVLink: {', '.join(info_parts)}")
        print(decoded)


def cmd_encode(args):
    """Encode signal values into a CAN frame."""
    codec = Codec(args.config)

    values = parse_signal_values(args.signals)
    node_id = args.node if args.node else 0

    try:
        msg_id, data = codec.encode(args.message, values, node_id=node_id)
    except (KeyError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    hex_str = data.hex(" ").upper()

    if args.json:
        result = {
            "id": f"0x{msg_id:03X}",
            "data_hex": hex_str,
            "data_bytes": list(data),
            "dlc": len(data),
        }
        if node_id != 0:
            result["node_id"] = node_id
        print(json.dumps(result, indent=2))
    elif args.cansend:
        # Format for cansend / cansend FD: can0 101#E803000005010000
        data_nospaces = data.hex().upper()
        fd_flag = "##1" if len(data) > 8 else "#"
        print(f"{args.bus} {msg_id:03X}{fd_flag}{data_nospaces}")
    elif args.mavlink:
        # MAVLink CAN transport format (29-bit extended ID)
        # CAN ID = 0x10000 | (system_id << 8) | component_id
        sys_id = args.sys_id if args.sys_id else 1
        comp_id = args.comp_id if args.comp_id else 1
        mavlink_can_id = 0x10000 | (sys_id << 8) | comp_id

        # Build full MAVLink v2 frame:
        # FD len incompat compat seq sys_id comp_id msg_id[3] payload crc[2]
        mavlink_msg_id = msg_id  # The message ID from the codec
        payload = data
        payload_len = len(payload)

        # Build header
        frame = bytearray()
        frame.append(0xFD)  # MAVLink v2 magic
        frame.append(payload_len)  # payload length
        frame.append(0x00)  # incompat_flags
        frame.append(0x00)  # compat_flags
        frame.append(0x00)  # seq (0 for single message)
        frame.append(sys_id)  # system_id
        frame.append(comp_id)  # component_id
        # msg_id is 3 bytes, little-endian
        frame.append(mavlink_msg_id & 0xFF)
        frame.append((mavlink_msg_id >> 8) & 0xFF)
        frame.append((mavlink_msg_id >> 16) & 0xFF)
        # payload
        frame.extend(payload)
        # CRC (X.25 checksum over bytes 1..end, plus CRC_EXTRA)
        # For simplicity, use placeholder CRC (real implementation needs CRC_EXTRA per message)
        crc = _mavlink_crc(frame[1:])
        frame.append(crc & 0xFF)
        frame.append((crc >> 8) & 0xFF)

        # Split into CAN FD frames (max 64 bytes each)
        max_frame_len = 64
        offset = 0
        frame_num = 0
        while offset < len(frame):
            chunk = frame[offset:offset + max_frame_len]
            chunk_hex = chunk.hex().upper()
            # Extended frame format for cansend: use 8 hex digits for 29-bit ID
            fd_flag = "##1" if len(chunk) > 8 else "#"
            if frame_num > 0:
                print(f"{args.bus} {mavlink_can_id:08X}{fd_flag}{chunk_hex}")
            else:
                print(f"{args.bus} {mavlink_can_id:08X}{fd_flag}{chunk_hex}")
            offset += max_frame_len
            frame_num += 1
    else:
        print(f"ID:   0x{msg_id:03X}")
        if node_id != 0:
            print(f"Node: {node_id}")
        print(f"Data: [{hex_str}]")
        print(f"DLC:  {len(data)}")


def cmd_monitor(args):
    """Start live CAN bus monitoring."""
    codec = Codec(args.config)

    filter_ids = None
    if args.filter:
        filter_ids = [int(x, 0) for x in args.filter.split(",")]

    log_file = None
    if args.log:
        log_file = open(args.log, "a")

    kwargs = dict(
        codec=codec,
        bus=args.bus,
        interface=args.interface,
        fd=not args.no_fd,
        filter_ids=filter_ids,
        detailed=args.detailed,
        show_unknown=not args.hide_unknown,
        log_file=log_file,
    )

    try:
        if args.summary:
            from .monitor import SummaryMonitor
            monitor = SummaryMonitor(**kwargs, refresh_rate=args.refresh)
        else:
            from .monitor import Monitor
            monitor = Monitor(**kwargs)

        monitor.run()

    finally:
        if log_file:
            log_file.close()


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        prog="canfd-codec",
        description="CAN FD message encoder/decoder with configurable rules",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "-c", "--config",
        default=os.environ.get("CANFD_CONFIG", "./configs"),
        help="Config file or directory (default: ./configs or $CANFD_CONFIG)",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    # --- list ---
    p_list = sub.add_parser("list", help="List all known messages")
    p_list.add_argument("--json", action="store_true", help="Output as JSON")

    # --- describe ---
    p_desc = sub.add_parser("describe", help="Describe a message in detail")
    p_desc.add_argument("message", help="Message name")

    # --- decode ---
    p_dec = sub.add_parser("decode", help="Decode a raw CAN frame")
    p_dec.add_argument("id", help="CAN ID (hex, e.g., 0x201 or 0x00010101 for MAVLink)")
    p_dec.add_argument("data", help="Data bytes as hex (e.g., 'E8 03 00 00')")
    p_dec.add_argument("--json", action="store_true", help="Output as JSON")
    p_dec.add_argument("--mavlink", action="store_true",
                       help="MAVLink CAN transport mode: extract sys_id/comp_id from CAN ID, auto-detect message by DLC")

    # --- encode ---
    p_enc = sub.add_parser("encode", help="Encode signal values into a CAN frame")
    p_enc.add_argument("message", help="Message name (e.g., SetSpeed)")
    p_enc.add_argument("signals", nargs="+",
                       help="Signal values as name=value pairs")
    p_enc.add_argument("-n", "--node", type=int,
                       help="Node ID for multi-node messages (actual_id = base_id + node_id * offset)")
    p_enc.add_argument("--json", action="store_true", help="Output as JSON")
    p_enc.add_argument("--cansend", action="store_true",
                       help="Output in cansend format")
    p_enc.add_argument("--mavlink", action="store_true",
                       help="Output in MAVLink CAN transport format (29-bit extended ID)")
    p_enc.add_argument("--sys-id", type=int, default=1,
                       help="MAVLink System ID (default: 1)")
    p_enc.add_argument("--comp-id", type=int, default=1,
                       help="MAVLink Component ID (default: 1)")
    p_enc.add_argument("--bus", default="vcan0",
                       help="Bus name for cansend/mavlink output (default: vcan0)")

    # --- monitor ---
    p_mon = sub.add_parser("monitor", help="Live CAN bus monitor")
    p_mon.add_argument("--bus", default="vcan0",
                       help="CAN bus name (default: vcan0)")
    p_mon.add_argument("--interface", default="socketcan",
                       help="python-can interface (default: socketcan)")
    p_mon.add_argument("--no-fd", action="store_true",
                       help="Disable CAN FD mode")
    p_mon.add_argument("--filter",
                       help="Comma-separated CAN IDs to filter (e.g., 0x201,0x202)")
    p_mon.add_argument("--detailed", action="store_true",
                       help="Show detailed multi-line output per frame")
    p_mon.add_argument("--hide-unknown", action="store_true",
                       help="Hide frames with unknown IDs")
    p_mon.add_argument("--summary", action="store_true",
                       help="Show live-updating summary instead of scrolling")
    p_mon.add_argument("--refresh", type=float, default=0.25,
                       help="Summary refresh rate in seconds (default: 0.25)")
    p_mon.add_argument("--log", help="Log decoded output to file")

    args = parser.parse_args()

    handlers = {
        "list": cmd_list,
        "describe": cmd_describe,
        "decode": cmd_decode,
        "encode": cmd_encode,
        "monitor": cmd_monitor,
    }
    handlers[args.command](args)


if __name__ == "__main__":
    main()
