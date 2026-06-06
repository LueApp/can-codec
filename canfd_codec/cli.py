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


def parse_broadcast_values(args: list[str]) -> dict:
    """
    Parse signal=value pairs for broadcast mode.

    Array values stay as lists (distributed per-node), scalars stay scalar.
      position=[1.5,2.0,2.5]  -> {"position": [1.5, 2.0, 2.5]}
      velocity=0               -> {"velocity": 0.0}
      mode=mit_control          -> {"mode": "mit_control"}
    """
    values: dict = {}
    for arg in args:
        if "=" not in arg:
            print(f"Error: Invalid signal format '{arg}'. Expected: name=value",
                  file=sys.stderr)
            sys.exit(1)

        name, val_str = arg.split("=", 1)
        name = name.strip()
        val_str = val_str.strip()

        if val_str.startswith("[") and val_str.endswith("]"):
            inner = val_str[1:-1]
            items = [s.strip() for s in inner.split(",")]
            parsed = []
            for item in items:
                try:
                    parsed.append(float(item) if "." in item else int(item, 0))
                except ValueError:
                    parsed.append(item)
            values[name] = parsed
        else:
            try:
                values[name] = float(val_str) if "." in val_str else int(val_str, 0)
            except ValueError:
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


def _print_decoded(decoded, can_id: int, args, mavlink_info: dict | None):
    """Render one DecodedMessage, with optional MAVLink context."""
    if mavlink_info:
        decoded.msg_id = can_id

    if args.json:
        result = {
            "id": f"0x{decoded.msg_id:03X}",
            "name": decoded.name,
            "raw_hex": decoded.raw_data.hex(" "),
        }
        if mavlink_info:
            result["mavlink"] = mavlink_info
        if decoded.is_broadcast and decoded.sub_messages:
            result["broadcast"] = True
            result["nodes"] = {}
            for sub in decoded.sub_messages:
                node_signals = {}
                for s in sub.signals:
                    sig_data = {
                        "raw": s.raw_value,
                        "value": s.physical_value,
                        "display": s.display_value(),
                    }
                    if s.enum_name:
                        sig_data["enum"] = s.enum_name
                    if s.bitfield_flags:
                        sig_data["flags"] = s.bitfield_flags
                    node_signals[s.name] = sig_data
                result["nodes"][str(sub.node_id)] = node_signals
        else:
            result["signals"] = {}
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
            sender = f"{mavlink_info['sender_sys']}.{mavlink_info['sender_comp']}"
            tgt_sys = mavlink_info['target_sys']
            tgt_comp = mavlink_info['target_comp']
            target = "broadcast" if (tgt_sys == 0 and tgt_comp == 0) else f"{tgt_sys}.{tgt_comp}"
            info_parts = [f"sender={sender}", f"target={target}"]
            if 'msg_id' in mavlink_info:
                info_parts.append(f"msg_id=0x{mavlink_info['msg_id']:X}")
            if 'seq' in mavlink_info:
                info_parts.append(f"seq={mavlink_info['seq']}")
            print(f"MAVLink: {', '.join(info_parts)}")
        print(decoded)


def cmd_decode(args):
    """Decode raw CAN frame(s). Multiple data values are reassembled for MAVLink."""
    codec = Codec(args.config)

    can_id = int(args.id, 0)
    frames = [parse_hex_data(d) for d in args.data]

    from .mavlink_loader import mavlink_can_is_mavlink

    if args.mavlink and mavlink_can_is_mavlink(can_id):
        from .mavlink_loader import (
            MavlinkReassembler, parse_mavlink_v2_header,
            mavlink_can_id_sender_sys, mavlink_can_id_sender_comp,
            mavlink_can_id_target_sys, mavlink_can_id_target_comp,
        )

        sender_sys = mavlink_can_id_sender_sys(can_id)
        sender_comp = mavlink_can_id_sender_comp(can_id)
        target_sys = mavlink_can_id_target_sys(can_id)
        target_comp = mavlink_can_id_target_comp(can_id)

        reasm = MavlinkReassembler()
        completed: list[bytes] = []
        for f in frames:
            completed.extend(reasm.feed(can_id, f))

        if not completed:
            print("Error: No complete MAVLink v2 frame in provided data", file=sys.stderr)
            sys.exit(1)

        any_decoded = False
        for full_frame in completed:
            hdr = parse_mavlink_v2_header(full_frame)
            if hdr is None:
                continue
            mavlink_info = {
                "sender_sys": sender_sys,
                "sender_comp": sender_comp,
                "target_sys": target_sys,
                "target_comp": target_comp,
                "frame_sys_id": hdr["sys_id"],
                "frame_comp_id": hdr["comp_id"],
                "msg_id": hdr["msg_id"],
                "seq": hdr["seq"],
            }
            decoded = codec.decode_mavlink(hdr["msg_id"], hdr["payload"], actual_can_id=can_id)
            if decoded is None:
                print(f"Error: Unknown MAVLink message ID 0x{hdr['msg_id']:X}", file=sys.stderr)
                continue
            _print_decoded(decoded, can_id, args, mavlink_info)
            any_decoded = True
        if not any_decoded:
            sys.exit(1)
        return

    if args.mavlink and not mavlink_can_is_mavlink(can_id):
        print(f"Warning: CAN ID 0x{can_id:08X} does not have MAVLink marker bit (bit 28) set",
              file=sys.stderr)

    # Standard decode (one or more frames)
    for data in frames:
        decoded = codec.decode(can_id, data)
        if decoded is None:
            print(f"Error: Unknown message ID 0x{can_id:03X}", file=sys.stderr)
            print(f"Known IDs: {', '.join(f'0x{m.id:03X}' for d in codec.devices for m in d.messages)}",
                  file=sys.stderr)
            sys.exit(1)
        _print_decoded(decoded, can_id, args, None)


def cmd_encode(args):
    """Encode signal values into a CAN frame."""
    codec = Codec(args.config)

    is_broadcast = getattr(args, "broadcast", False)

    if is_broadcast:
        values = parse_broadcast_values(args.signals)
    else:
        values = parse_signal_values(args.signals)
    node_id = args.node if args.node else 0

    try:
        msg_id, data = codec.encode(args.message, values, node_id=node_id,
                                    broadcast=is_broadcast)
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
        if is_broadcast:
            result["broadcast"] = True
        elif node_id != 0:
            result["node_id"] = node_id
        print(json.dumps(result, indent=2))
    elif args.cansend:
        # Format for cansend / cansend FD: can0 101#E803000005010000
        data_nospaces = data.hex().upper()
        fd_flag = "##1" if len(data) > 8 else "#"
        print(f"{args.bus} {msg_id:03X}{fd_flag}{data_nospaces}")
    elif args.mavlink:
        from .mavlink_loader import build_mavlink_v2_frame, mavlink_can_make_id

        # 29-bit ID = HEADER | sender_sys | sender_comp | target_sys | target_comp
        # (destination-based routing, see mavlink_can_transport.h). Sender is the
        # local node (--sys-id/--comp-id). Target defaults to the message's own
        # target_system/target_component field values, else broadcast (0,0).
        # argparse already defaults these to 1; honor an explicit 0 (matches web parity)
        sender_sys = args.sys_id
        sender_comp = args.comp_id

        def _field_int(key: str) -> int | None:
            if key not in values:
                return None
            try:
                return int(values[key])
            except (TypeError, ValueError):
                return None

        target_sys = args.target_sys if args.target_sys is not None else (_field_int("target_system") or 0)
        target_comp = args.target_comp if args.target_comp is not None else (_field_int("target_component") or 0)
        mavlink_can_id = mavlink_can_make_id(sender_sys, sender_comp, target_sys, target_comp)

        # Look up CRC_EXTRA for this message
        entry = codec._by_name.get(args.message)
        if entry is None:
            print(f"Error: Unknown message '{args.message}'", file=sys.stderr)
            sys.exit(1)
        _, msg_def = entry
        if msg_def.crc_extra is None:
            print(f"Error: No CRC_EXTRA for '{args.message}' (not a MAVLink message?)", file=sys.stderr)
            sys.exit(1)

        frame = build_mavlink_v2_frame(
            msg_id=msg_id,
            payload=data,
            crc_extra=msg_def.crc_extra,
            sys_id=sender_sys,
            comp_id=sender_comp,
        )

        # Split into CAN FD frames (max 64 bytes each)
        max_frame_len = 64
        offset = 0
        while offset < len(frame):
            chunk = frame[offset:offset + max_frame_len]
            chunk_hex = chunk.hex().upper()
            fd_flag = "##1" if len(chunk) > 8 else "#"
            print(f"{args.bus} {mavlink_can_id:08X}{fd_flag}{chunk_hex}")
            offset += max_frame_len
    else:
        print(f"ID:   0x{msg_id:03X}")
        if is_broadcast:
            print(f"Mode: broadcast")
        elif node_id != 0:
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
        bitrate=args.bitrate,
        data_bitrate=args.data_bitrate,
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


def cmd_genlib(args):
    """Generate a standalone codec library for a target language."""
    from .codegen import generate, extension_for, GENERATORS
    from .codegen.common import to_snake_case

    lang = args.lang.lower()
    if lang not in GENERATORS:
        print(f"Error: unknown language '{lang}'. Choose one of: {sorted(set(GENERATORS.keys()))}",
              file=sys.stderr)
        sys.exit(1)

    codec = Codec(args.config)
    if not codec.devices:
        print(f"Error: no devices loaded from {args.config}", file=sys.stderr)
        sys.exit(1)

    ext = extension_for(lang)
    out_path = args.output

    # Decide single-file vs directory output
    write_dir = False
    if out_path is None:
        if len(codec.devices) > 1:
            print(f"Error: {len(codec.devices)} devices loaded but no --output given. "
                  "Use --output <dir/> to write per-device files, or point -c at a single config file.",
                  file=sys.stderr)
            sys.exit(1)
    else:
        # Treat as directory if it ends with '/' or already exists as a dir, or no extension
        if out_path.endswith(os.sep) or os.path.isdir(out_path) or "." not in os.path.basename(out_path):
            write_dir = True
            os.makedirs(out_path, exist_ok=True)

    if not write_dir and len(codec.devices) > 1:
        print(f"Error: {len(codec.devices)} devices loaded but --output is a single file. "
              "Use a directory path (with trailing /) to write per-device files.",
              file=sys.stderr)
        sys.exit(1)

    for dev in codec.devices:
        source = generate(lang, dev)
        if out_path is None:
            sys.stdout.write(source)
        elif write_dir:
            fname = f"{to_snake_case(dev.name)}{ext}"
            fpath = os.path.join(out_path, fname)
            with open(fpath, "w") as f:
                f.write(source)
            print(f"Wrote {fpath}", file=sys.stderr)
        else:
            with open(out_path, "w") as f:
                f.write(source)
            print(f"Wrote {out_path}", file=sys.stderr)


def cmd_serve(args):
    """Start WebSocket server for live CAN frame streaming."""
    from .serve import CANWebSocketServer

    filter_ids = None
    if args.filter:
        filter_ids = {int(x, 0) for x in args.filter.split(",")}

    server = CANWebSocketServer(
        bus=args.bus,
        interface=args.interface,
        fd=not args.no_fd,
        bitrate=args.bitrate,
        data_bitrate=args.data_bitrate,
        host=args.host,
        port=args.port,
        filter_ids=filter_ids,
        source_url=args.source,
    )

    import asyncio
    asyncio.run(server.run())


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
    p_dec.add_argument("data", nargs="+",
                       help="Data bytes as hex per CAN frame (e.g., 'E8 03 00 00'). "
                            "Pass multiple values to reassemble a multi-frame MAVLink message.")
    p_dec.add_argument("--json", action="store_true", help="Output as JSON")
    p_dec.add_argument("--mavlink", action="store_true",
                       help="MAVLink CAN transport mode: extract sender/target sys.comp from the "
                            "29-bit CAN ID (bit-28 header) and parse the MAVLink v2 frame")

    # --- encode ---
    p_enc = sub.add_parser("encode", help="Encode signal values into a CAN frame")
    p_enc.add_argument("message", help="Message name (e.g., SetSpeed)")
    p_enc.add_argument("signals", nargs="+",
                       help="Signal values as name=value pairs")
    p_enc.add_argument("-n", "--node", type=int,
                       help="Node ID for multi-node messages (actual_id = base_id + node_id * offset)")
    p_enc.add_argument("-b", "--broadcast", action="store_true",
                       help="Broadcast mode: concatenate all nodes into one frame. "
                            "Array values (e.g. position=[1.5,2.0,...]) are distributed per-node; "
                            "scalar values are shared across all nodes.")
    p_enc.add_argument("--json", action="store_true", help="Output as JSON")
    p_enc.add_argument("--cansend", action="store_true",
                       help="Output in cansend format")
    p_enc.add_argument("--mavlink", action="store_true",
                       help="Output in MAVLink CAN transport format (29-bit extended ID)")
    p_enc.add_argument("--sys-id", type=int, default=1,
                       help="Local (sender) MAVLink System ID (default: 1)")
    p_enc.add_argument("--comp-id", type=int, default=1,
                       help="Local (sender) MAVLink Component ID, 0-63 (default: 1)")
    p_enc.add_argument("--target-sys", type=int, default=None,
                       help="Target (destination) System ID. Defaults to the message's "
                            "target_system field, else 0 (broadcast).")
    p_enc.add_argument("--target-comp", type=int, default=None,
                       help="Target (destination) Component ID, 0-63. Defaults to the message's "
                            "target_component field, else 0 (broadcast).")
    p_enc.add_argument("--bus", default="vcan0",
                       help="Bus name for cansend/mavlink output (default: vcan0)")

    # --- monitor ---
    p_mon = sub.add_parser("monitor", help="Live CAN bus monitor")
    p_mon.add_argument("--bus", default="vcan0",
                       help="CAN bus name (default: vcan0)")
    p_mon.add_argument("--interface", default="socketcan",
                       help="python-can interface (default: socketcan)")
    p_mon.add_argument("--bitrate", type=int,
                       help="CAN bus bitrate in bit/s (e.g., 1000000)")
    p_mon.add_argument("--data-bitrate", type=int,
                       help="CAN FD data phase bitrate in bit/s (e.g., 5000000)")
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

    # --- genlib ---
    p_gen = sub.add_parser("genlib", help="Generate a standalone codec library for a target language")
    p_gen.add_argument("--lang", required=True,
                       choices=["python", "py", "python3", "c", "cpp", "c++", "rust", "rs"],
                       help="Target language")
    p_gen.add_argument("-o", "--output",
                       help="Output file or directory. If omitted, prints to stdout. "
                            "If the path ends in '/' or already exists as a directory, "
                            "writes one file per device named after the device.")

    # --- serve ---
    p_srv = sub.add_parser("serve", help="WebSocket server for live CAN frame streaming")
    p_srv.add_argument("--bus", default="vcan0",
                       help="CAN bus name (default: vcan0)")
    p_srv.add_argument("--interface", default="socketcan",
                       help="python-can interface (default: socketcan)")
    p_srv.add_argument("--bitrate", type=int,
                       help="CAN bus bitrate in bit/s (e.g., 1000000)")
    p_srv.add_argument("--data-bitrate", type=int,
                       help="CAN FD data phase bitrate in bit/s (e.g., 5000000)")
    p_srv.add_argument("--no-fd", action="store_true",
                       help="Disable CAN FD mode")
    p_srv.add_argument("--host", default="0.0.0.0",
                       help="WebSocket server bind address (default: 0.0.0.0)")
    p_srv.add_argument("--port", type=int, default=8765,
                       help="WebSocket server port (default: 8765)")
    p_srv.add_argument("--filter",
                       help="Comma-separated CAN IDs to filter (e.g., 0x201,0x202)")
    p_srv.add_argument("--source",
                       help="Connect to a remote serve.py instead of local candump "
                            "(e.g. ws://192.168.25.201:8765)")

    args = parser.parse_args()

    handlers = {
        "list": cmd_list,
        "describe": cmd_describe,
        "decode": cmd_decode,
        "encode": cmd_encode,
        "monitor": cmd_monitor,
        "serve": cmd_serve,
        "genlib": cmd_genlib,
    }
    handlers[args.command](args)


if __name__ == "__main__":
    main()
