import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from canfd_codec.codec import DeviceConfig, decode, encode
from canfd_codec.codegen import generate
from canfd_codec.mavlink_loader import _parse_enums, load_mavlink_xml


ROOT = Path(__file__).resolve().parents[1]
MAVLINK_XML = ROOT / "configs" / "mavlink" / "user_define.xml"
MINIMAL_XML = ROOT / "configs" / "mavlink" / "minimal.xml"
MARSH_XML = ROOT / "configs" / "mavlink" / "marsh.xml"
COMMON_XML = ROOT / "configs" / "mavlink" / "common.xml"


class MavlinkCodegenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.device = load_mavlink_xml(MAVLINK_XML)
        cls.command = next(
            msg for msg in cls.device.messages if msg.name == "LINEAR_ACTUATOR_CMD"
        )

    def test_python_emits_crc_extra_and_no_xml_transport_defaults(self):
        source = generate("python", self.device)
        namespace = {}
        exec(compile(source, "<generated-mavlink>", "exec"), namespace)

        self.assertEqual(self.command.crc_extra, 57)
        self.assertEqual(namespace["LinearActuatorCmd"].CRC_EXTRA, 57)
        for name in (
            "DEVICE_BUS",
            "DEVICE_FD",
            "DEVICE_BITRATE",
            "DEVICE_DATA_BITRATE",
        ):
            self.assertNotIn(name, namespace)

    def test_other_targets_carry_crc_extra_without_xml_transport_defaults(self):
        expected = {
            "c": "#define USER_DEFINE_LINEAR_ACTUATOR_CMD_CRC_EXTRA 57u",
            "cpp": "static constexpr uint8_t CRC_EXTRA = 57u;",
            "rust": "pub const CRC_EXTRA: u8 = 57;",
        }
        for language, marker in expected.items():
            with self.subTest(language=language):
                source = generate(language, self.device)
                self.assertIn(marker, source)
                self.assertNotIn("DEVICE_FD", source)
                self.assertNotIn("DEVICE_BITRATE", source)
                self.assertNotIn("DEVICE_DATA_BITRATE", source)
                self.assertNotIn("_DATA_BITRATE", source)

    def test_yaml_transport_metadata_remains_available(self):
        device = DeviceConfig(
            name="classic_device",
            bus="can0",
            fd=False,
            bitrate=1_000_000,
            data_bitrate=2_000_000,
        )
        source = generate("python", device)
        namespace = {}
        exec(compile(source, "<generated-yaml>", "exec"), namespace)

        self.assertEqual(namespace["DEVICE_BUS"], "can0")
        self.assertFalse(namespace["DEVICE_FD"])
        self.assertEqual(namespace["DEVICE_BITRATE"], 1_000_000)

    def test_heartbeat_magic_version_field_is_constant_three(self):
        device = load_mavlink_xml(MINIMAL_XML)
        heartbeat = next(msg for msg in device.messages if msg.name == "HEARTBEAT")
        version = next(sig for sig in heartbeat.signals if sig.name == "mavlink_version")

        self.assertEqual(heartbeat.dlc, 9)
        self.assertEqual(heartbeat.crc_extra, 50)
        self.assertEqual(version.bit_length, 8)
        self.assertEqual(version.default, 3)
        self.assertTrue(version.constant)
        payload = encode(heartbeat, {
            "custom_mode": 0x11223344,
            "type": 6,
            "autopilot": 8,
            "base_mode": 0x81,
            "system_status": 4,
        })
        self.assertEqual(payload, bytes.fromhex("44 33 22 11 06 08 81 04 03"))

    def test_hexadecimal_mavlink_enum_values_load(self):
        enums = _parse_enums(ET.parse(MARSH_XML).getroot())
        flags = enums["MARSH_MODE_FLAGS"]
        self.assertEqual(flags[0x1000000], "marsh_mode_single_message")
        self.assertEqual(flags[0x2000000], "marsh_mode_all_messages")

    def test_system_time_uint64_payload_matches_robot_mavgen(self):
        device = load_mavlink_xml(COMMON_XML)
        system_time = next(msg for msg in device.messages if msg.name == "SYSTEM_TIME")
        values = {
            "time_unix_usec": 0xFEDCBA9876543210,
            "time_boot_ms": 0x11223344,
        }
        expected = bytes.fromhex("10 32 54 76 98 BA DC FE 44 33 22 11")

        self.assertEqual(system_time.dlc, 12)
        self.assertEqual(system_time.crc_extra, 137)
        self.assertEqual(encode(system_time, values), expected)

        single_message_device = DeviceConfig(
            name="common",
            mavlink=True,
            messages=[system_time],
        )
        namespace = {}
        exec(
            compile(generate("python", single_message_device), "<generated-system-time>", "exec"),
            namespace,
        )
        generated = namespace["SystemTime"](**values)
        _, generated_payload = generated.encode()
        self.assertEqual(generated_payload, expected)

    def test_numeric_string_float_input_remains_supported(self):
        device = load_mavlink_xml(COMMON_XML)
        attitude = next(msg for msg in device.messages if msg.name == "ATTITUDE")
        payload = encode(attitude, {"roll": "1.5"})
        result = decode(attitude, payload)
        roll = next(sig for sig in result.signals if sig.name == "roll")
        self.assertAlmostEqual(roll.physical_value, 1.5)

    @unittest.skipUnless(shutil.which("rustc"), "rustc is required for generated Rust verification")
    def test_rust_keyword_field_is_escaped_and_compiles(self):
        source = generate("rust", self.device)
        self.assertIn("pub r#type:", source)
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "user_define.rs"
            output_path = Path(temp_dir) / "libuser_define.rlib"
            source_path.write_text(source, encoding="utf-8")
            subprocess.run(
                [
                    "rustc", "--edition", "2021", "--crate-type", "lib",
                    "-D", "warnings", str(source_path), "-o", str(output_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertTrue(output_path.exists())


if __name__ == "__main__":
    unittest.main()
