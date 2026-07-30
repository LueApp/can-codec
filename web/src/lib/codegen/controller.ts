/**
 * Ready-to-run CAN controller starters for the generated device codec.
 *
 * The codec generators deliberately remain transport-free.  This module emits
 * a separate, editable entry point so a user can swap controllers without
 * forking their protocol library.
 */

import type { DeviceConfig, Message } from '../types';
import { toPascalCase, toSnakeCase, totalPayloadBytes } from './common';
import type { GenLang } from './index';

export const CAN_CONTROLLERS = [
  'none',
  'socketcan-python',
  'slcanfd-python',
  'socketcan-c',
  'stm32-fdcan',
  'esp-idf-twai',
] as const;

export type CanController = typeof CAN_CONTROLLERS[number];

const CONTROLLER_LABELS: Record<CanController, string> = {
  none: 'Codec only',
  'socketcan-python': 'Linux SocketCAN · Python',
  'slcanfd-python': 'USB SLCAN-FD · Python 3',
  'socketcan-c': 'Linux SocketCAN · C99',
  'stm32-fdcan': 'STM32 HAL · FDCAN',
  'esp-idf-twai': 'ESP-IDF · TWAI (classic CAN)',
};

const CONTROLLER_LANGUAGES: Partial<Record<CanController, GenLang>> = {
  'socketcan-python': 'python',
  'slcanfd-python': 'python',
  'socketcan-c': 'c',
  'stm32-fdcan': 'c',
  'esp-idf-twai': 'c',
};

export function labelForController(controller: CanController): string {
  return CONTROLLER_LABELS[controller];
}

/** A hardware starter must be paired with the matching generated codec language. */
export function requiredLanguage(controller: CanController): GenLang | null {
  return CONTROLLER_LANGUAGES[controller] ?? null;
}

/** ESP32 TWAI is classic CAN only; all other profiles handle CAN FD. */
export function isControllerCompatible(controller: CanController, device: DeviceConfig): boolean {
  if (controller === 'none') return true;
  if (device.mavlink) return false;
  if (controller !== 'esp-idf-twai') return true;
  return !device.fd && device.messages.every((message) => totalPayloadBytes(message) <= 8);
}

export function suggestedControllerFilename(controller: CanController, device: DeviceConfig): string {
  const stem = toSnakeCase(device.name) || 'device';
  switch (controller) {
    case 'socketcan-python': return `${stem}_socketcan.py`;
    case 'slcanfd-python': return `${stem}_slcanfd.py`;
    case 'socketcan-c': return `${stem}_socketcan.c`;
    case 'stm32-fdcan': return `${stem}_fdcan.c`;
    case 'esp-idf-twai': return `${stem}_twai.c`;
    default: return '';
  }
}

function exampleMessage(device: DeviceConfig): Message | null {
  return device.messages.find((message) => message.direction === 'tx') ?? device.messages[0] ?? null;
}

function cSymbols(device: DeviceConfig, message: Message) {
  const prefix = `${toSnakeCase(device.name) || 'device'}_${toSnakeCase(message.name)}`;
  return {
    prefix,
    type: `${prefix}_t`,
    encode: `${prefix}_encode`,
    idForNode: `${prefix}_id_for_node`,
    nodeStart: `${prefix}_NODE_ID_START`,
  };
}

function exampleUsesExtendedId(message: Message): boolean {
  return message.id + message.node_id_start * message.node_id_offset > 0x7ff;
}

function slcanSerialPort(device: DeviceConfig): string {
  return device.bus.startsWith('/dev/') || /^COM\d+$/i.test(device.bus)
    ? device.bus
    : '/dev/ttyACM0';
}

function pythonSocketCanStarter(device: DeviceConfig, codecFilename: string, message: Message): string {
  const moduleName = codecFilename.replace(/\.py$/, '');
  const messageClass = toPascalCase(message.name);
  const fd = device.fd ? 'True' : 'False';
  return `"""Send one ${message.name} frame through Linux SocketCAN.

Keep this file editable; regenerate the companion codec (${codecFilename}) when
the YAML protocol definition changes.
"""
import socket
import struct

import ${moduleName}

INTERFACE = ${JSON.stringify(device.bus)}
USE_CAN_FD = ${fd}


def open_can(interface: str) -> socket.socket:
    sock = socket.socket(socket.PF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
    if USE_CAN_FD:
        sock.setsockopt(socket.SOL_CAN_RAW, socket.CAN_RAW_FD_FRAMES, 1)
    sock.bind((interface,))
    return sock


def send_frame(sock: socket.socket, can_id: int, payload: bytes) -> None:
    if USE_CAN_FD:
        if len(payload) > 64:
            raise ValueError('CAN FD payloads are limited to 64 bytes')
        # struct canfd_frame: can_id, len, flags, reserved[2], data[64]
        frame = struct.pack('=IBBBB64s', can_id, len(payload), 0, 0, 0, payload.ljust(64, b'\\0'))
    else:
        if len(payload) > 8:
            raise ValueError('Classic CAN payloads are limited to 8 bytes')
        # struct can_frame: can_id, can_dlc, pad/reserved[3], data[8]
        frame = struct.pack('=IBBBB8s', can_id, len(payload), 0, 0, 0, payload.ljust(8, b'\\0'))
    sock.send(frame)


with open_can(INTERFACE) as can:
    # Set the generated message fields before sending. Defaults come from YAML.
    command = ${moduleName}.${messageClass}()
    can_id, payload = command.encode(node_id=command.NODE_ID_START)
    if can_id > 0x7FF:
        can_id |= socket.CAN_EFF_FLAG
    send_frame(can, can_id, payload)
    print(f'sent 0x{can_id:X}: {payload.hex(" ")}')
`;
}

function pythonSlcanFdStarter(device: DeviceConfig, codecFilename: string, message: Message): string {
  const moduleName = codecFilename.replace(/\.py$/, '');
  const messageClass = toPascalCase(message.name);
  const fd = device.fd ? 'True' : 'False';
  const bitrate = device.bitrate ?? 500000;
  const dataBitrate = device.data_bitrate ?? 2000000;
  return `"""Send one ${message.name} frame through a USB SLCAN/SLCAN-FD adapter.

Install the transport dependencies first:
    python3 -m pip install python-can pyserial

Keep this file editable; regenerate the companion codec (${codecFilename}) when
the YAML protocol definition changes.
"""
import can

import ${moduleName}

SERIAL_PORT = ${JSON.stringify(slcanSerialPort(device))}
SERIAL_BAUD = 115200  # Often ignored by USB CDC adapters; adjust if required.
BITRATE = ${bitrate}
DATA_BITRATE = ${dataBitrate}  # python-can SLCAN-FD supports 2M or 5M.
USE_CAN_FD = ${fd}


def open_slcan() -> can.BusABC:
    bus = can.Bus(
        interface='slcan',
        channel=SERIAL_PORT,
        tty_baudrate=SERIAL_BAUD,
        bitrate=BITRATE,
    )
    if USE_CAN_FD:
        bus.set_bitrate(BITRATE, DATA_BITRATE)
    return bus


with open_slcan() as bus:
    # Set the generated message fields before sending. Defaults come from YAML.
    command = ${moduleName}.${messageClass}()
    can_id, payload = command.encode(node_id=command.NODE_ID_START)
    frame = can.Message(
        arbitration_id=can_id,
        data=payload,
        is_extended_id=can_id > 0x7FF,
        is_fd=USE_CAN_FD,
        bitrate_switch=USE_CAN_FD,
        check=True,
    )
    bus.send(frame, timeout=1.0)
    print(f'sent 0x{can_id:X}: {payload.hex(" ")}')
`;
}

function cSocketCanStarter(device: DeviceConfig, codecFilename: string, message: Message): string {
  const c = cSymbols(device, message);
  const frameType = device.fd ? 'struct canfd_frame' : 'struct can_frame';
  const frameLength = device.fd ? 'len' : 'can_dlc';
  const extendedId = exampleUsesExtendedId(message) ? 'can_id | CAN_EFF_FLAG' : 'can_id';
  const fdSetup = device.fd
    ? `    int enable_fd = 1;
    if (setsockopt(sock, SOL_CAN_RAW, CAN_RAW_FD_FRAMES, &enable_fd, sizeof(enable_fd)) < 0) {
        perror("CAN_RAW_FD_FRAMES");
        close(sock);
        return -1;
    }
`
    : '';
  return `/* Linux SocketCAN starter for ${device.name}. */
#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE  /* Exposes struct ifreq with -std=c99 on glibc. */
#endif
#include "${codecFilename}"

#include <errno.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static int open_can(const char *interface) {
    int sock = socket(PF_CAN, SOCK_RAW, CAN_RAW);
    if (sock < 0) { perror("socket"); return -1; }
${fdSetup}    struct ifreq ifr = {0};
    strncpy(ifr.ifr_name, interface, IFNAMSIZ - 1);
    if (ioctl(sock, SIOCGIFINDEX, &ifr) < 0) { perror("SIOCGIFINDEX"); close(sock); return -1; }
    struct sockaddr_can address = { .can_family = AF_CAN, .can_ifindex = ifr.ifr_ifindex };
    if (bind(sock, (struct sockaddr *)&address, sizeof(address)) < 0) {
        perror("bind"); close(sock); return -1;
    }
    return sock;
}

int main(void) {
    int sock = open_can(${JSON.stringify(device.bus)});
    if (sock < 0) return 1;

    /* Set generated fields here. A zero initializer applies YAML constants. */
    ${c.type} command = {0};
    uint8_t payload[64];
    size_t length = ${c.encode}(&command, payload, sizeof(payload));
    uint32_t can_id = ${c.idForNode}(${c.nodeStart});

    ${frameType} frame = {0};
    frame.can_id = ${extendedId};
    frame.${frameLength} = length;
    memcpy(frame.data, payload, length);
    if (write(sock, &frame, sizeof(frame)) != (ssize_t)sizeof(frame)) {
        perror("write"); close(sock); return 1;
    }
    printf("sent 0x%X (%zu bytes)\\n", can_id, length);
    close(sock);
    return 0;
}
`;
}

function stm32FdcanStarter(device: DeviceConfig, codecFilename: string, message: Message): string {
  const c = cSymbols(device, message);
  const idType = exampleUsesExtendedId(message) ? 'FDCAN_EXTENDED_ID' : 'FDCAN_STANDARD_ID';
  const fdFormat = device.fd ? 'FDCAN_FD_CAN' : 'FDCAN_CLASSIC_CAN';
  const bitRateSwitch = device.fd ? 'FDCAN_BRS_ON' : 'FDCAN_BRS_OFF';
  return `/* STM32Cube HAL FDCAN starter for ${device.name}. */
#include "main.h"
#include "${codecFilename}"
#include <string.h>

extern FDCAN_HandleTypeDef hfdcan1;  /* Generated by STM32CubeMX. */

static uint32_t fdcan_dlc(size_t length) {
    switch (length) {
        case 0: return FDCAN_DLC_BYTES_0;  case 1: return FDCAN_DLC_BYTES_1;
        case 2: return FDCAN_DLC_BYTES_2;  case 3: return FDCAN_DLC_BYTES_3;
        case 4: return FDCAN_DLC_BYTES_4;  case 5: return FDCAN_DLC_BYTES_5;
        case 6: return FDCAN_DLC_BYTES_6;  case 7: return FDCAN_DLC_BYTES_7;
        case 8: return FDCAN_DLC_BYTES_8;  case 12: return FDCAN_DLC_BYTES_12;
        case 16: return FDCAN_DLC_BYTES_16; case 20: return FDCAN_DLC_BYTES_20;
        case 24: return FDCAN_DLC_BYTES_24; case 32: return FDCAN_DLC_BYTES_32;
        case 48: return FDCAN_DLC_BYTES_48; case 64: return FDCAN_DLC_BYTES_64;
        default: return FDCAN_DLC_BYTES_0;  /* Invalid CAN/CAN-FD length. */
    }
}

HAL_StatusTypeDef send_${toSnakeCase(message.name)}(void) {
    ${c.type} command = {0};  /* Set generated fields before encoding. */
    uint8_t payload[64] = {0};
    size_t length = ${c.encode}(&command, payload, sizeof(payload));
    if (length == 0) return HAL_ERROR;

    FDCAN_TxHeaderTypeDef header = {0};
    header.Identifier = ${c.idForNode}(${c.nodeStart});
    header.IdType = ${idType};
    header.TxFrameType = FDCAN_DATA_FRAME;
    header.DataLength = fdcan_dlc(length);
    header.ErrorStateIndicator = FDCAN_ESI_ACTIVE;
    header.BitRateSwitch = ${bitRateSwitch};
    header.FDFormat = ${fdFormat};
    header.TxEventFifoControl = FDCAN_NO_TX_EVENTS;
    header.MessageMarker = 0;

    return HAL_FDCAN_AddMessageToTxFifoQ(&hfdcan1, &header, payload);
}

/* Call HAL_FDCAN_Start(&hfdcan1) after CubeMX clock/GPIO/filter setup, then
 * call send_${toSnakeCase(message.name)}() from your application task. */
`;
}

function espIdfTwaiStarter(device: DeviceConfig, codecFilename: string, message: Message): string {
  const c = cSymbols(device, message);
  const extFlag = exampleUsesExtendedId(message) ? 'TWAI_MSG_FLAG_EXTD' : '0';
  return `/* ESP-IDF TWAI (classic CAN) starter for ${device.name}. */
#include "${codecFilename}"
#include "driver/twai.h"
#include "esp_err.h"
#include <string.h>

/* Choose the GPIO pins and timing for your board. */
void can_controller_init(void) {
    twai_general_config_t general = TWAI_GENERAL_CONFIG_DEFAULT(GPIO_NUM_5, GPIO_NUM_4, TWAI_MODE_NORMAL);
    twai_timing_config_t timing = TWAI_TIMING_CONFIG_500KBITS();
    twai_filter_config_t filter = TWAI_FILTER_CONFIG_ACCEPT_ALL();
    ESP_ERROR_CHECK(twai_driver_install(&general, &timing, &filter));
    ESP_ERROR_CHECK(twai_start());
}

esp_err_t send_${toSnakeCase(message.name)}(void) {
    ${c.type} command = {0};  /* Set generated fields before encoding. */
    twai_message_t frame = {
        .identifier = ${c.idForNode}(${c.nodeStart}),
        .data_length_code = ${totalPayloadBytes(message)},
        .flags = ${extFlag},
    };
    size_t length = ${c.encode}(&command, frame.data, sizeof(frame.data));
    if (length != frame.data_length_code) return ESP_ERR_INVALID_SIZE;
    return twai_transmit(&frame, pdMS_TO_TICKS(100));
}
`;
}

/**
 * Emit an editable controller entry point. It intentionally imports/includes
 * the generated codec rather than merging transport and protocol code.
 */
export function generateControllerStarter(
  controller: Exclude<CanController, 'none'>,
  device: DeviceConfig,
  codecFilename: string,
): string {
  const message = exampleMessage(device);
  if (!message) return '/* The selected device has no messages to send. */\n';

  switch (controller) {
    case 'socketcan-python': return pythonSocketCanStarter(device, codecFilename, message);
    case 'slcanfd-python': return pythonSlcanFdStarter(device, codecFilename, message);
    case 'socketcan-c': return cSocketCanStarter(device, codecFilename, message);
    case 'stm32-fdcan': return stm32FdcanStarter(device, codecFilename, message);
    case 'esp-idf-twai': return espIdfTwaiStarter(device, codecFilename, message);
  }
}
