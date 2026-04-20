"""
WebSocket bridge for live CAN bus frame streaming.

Broadcasts raw CAN frames as JSON to all connected WebSocket clients.
Decoding is performed client-side in the browser.
"""

import asyncio
import json
import logging
import signal as signal_module
import threading

logger = logging.getLogger(__name__)


class CANWebSocketServer:
    """WebSocket server that reads CAN frames from a bus and broadcasts them.

    Args:
        bus: CAN interface name (e.g., "can0", "vcan0")
        interface: python-can interface type (default: "socketcan")
        fd: Enable CAN FD mode
        host: WebSocket server bind address
        port: WebSocket server port
        filter_ids: Optional set of CAN IDs to forward (None = all)
    """

    def __init__(
        self,
        bus: str = "vcan0",
        interface: str = "socketcan",
        fd: bool = True,
        host: str = "0.0.0.0",
        port: int = 8765,
        filter_ids: set[int] | None = None,
    ):
        self.bus = bus
        self.interface = interface
        self.fd = fd
        self.host = host
        self.port = port
        self.filter_ids = filter_ids
        self._running = False
        self._clients: set = set()

    async def _handler(self, websocket):
        """Handle a single WebSocket client connection."""
        self._clients.add(websocket)
        remote = websocket.remote_address
        logger.info("Client connected: %s", remote)
        print(f"  Client connected: {remote} ({len(self._clients)} total)")

        # Send status message
        status = json.dumps({
            "type": "status",
            "bus": self.bus,
            "fd": self.fd,
        })
        try:
            await websocket.send(status)
        except Exception:
            pass

        try:
            # Keep connection alive until client disconnects
            async for _ in websocket:
                pass  # Ignore client messages
        finally:
            self._clients.discard(websocket)
            print(f"  Client disconnected: {remote} ({len(self._clients)} total)")

    def _can_reader_thread(self, loop: asyncio.AbstractEventLoop):
        """Thread that reads CAN frames and schedules broadcasts.

        Automatically reconnects if the CAN bus goes down, retrying every 1 second.
        """
        import can
        import time

        bus_config: dict = {"interface": self.interface, "channel": self.bus}
        if self.fd:
            bus_config["fd"] = True

        print(f"  CAN bus: {self.bus} (interface={self.interface}, fd={self.fd})")

        while self._running:
            try:
                with can.Bus(**bus_config) as bus_conn:
                    print(f"  CAN bus connected: {self.bus}")
                    self._notify_bus_status(loop, connected=True)
                    while self._running:
                        msg = bus_conn.recv(timeout=1.0)
                        if msg is None:
                            continue
                        if self.filter_ids and msg.arbitration_id not in self.filter_ids:
                            continue
                        if not self._clients:
                            continue

                        frame_json = json.dumps({
                            "type": "frame",
                            "arbitration_id": msg.arbitration_id,
                            "data": bytes(msg.data).hex().upper(),
                            "timestamp": msg.timestamp,
                            "is_fd": msg.is_fd,
                        })

                        loop.call_soon_threadsafe(self._broadcast_sync, frame_json)
            except Exception as e:
                logger.error("CAN reader error: %s", e)
                print(f"  CAN bus lost: {e}")
                self._notify_bus_status(loop, connected=False, error=str(e))
                if not self._running:
                    break
                print(f"  Reconnecting to {self.bus} in 1s...")
                time.sleep(1)

    def _notify_bus_status(self, loop: asyncio.AbstractEventLoop, connected: bool, error: str | None = None):
        """Notify connected WebSocket clients about CAN bus status changes."""
        msg = json.dumps({
            "type": "status",
            "bus": self.bus,
            "fd": self.fd,
            "connected": connected,
            **({"error": error} if error else {}),
        })
        if self._clients:
            loop.call_soon_threadsafe(self._broadcast_sync, msg)

    def _broadcast_sync(self, message: str):
        """Schedule broadcast from the CAN reader thread."""
        import websockets

        websockets.broadcast(self._clients, message)

    async def run(self):
        """Start the WebSocket server and CAN reader. Blocks until stopped."""
        import websockets

        self._running = True
        loop = asyncio.get_running_loop()

        # Graceful shutdown on SIGINT/SIGTERM
        for sig in (signal_module.SIGINT, signal_module.SIGTERM):
            loop.add_signal_handler(sig, self.stop)

        # Start WebSocket server (disable ping to avoid timeout on busy buses)
        async with websockets.serve(self._handler, self.host, self.port, ping_interval=None):
            print(f"WebSocket server listening on ws://{self.host}:{self.port}")

            # Start CAN reader in a background thread
            reader_thread = threading.Thread(
                target=self._can_reader_thread,
                args=(loop,),
                daemon=True,
            )
            reader_thread.start()

            # Wait until stopped
            while self._running:
                await asyncio.sleep(0.5)

        reader_thread.join(timeout=3.0)
        print("\nServer stopped.")

    def stop(self):
        """Signal the server to stop."""
        self._running = False
