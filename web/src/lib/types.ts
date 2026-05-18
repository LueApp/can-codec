export interface Signal {
  name: string;
  start_bit: number;
  bit_length: number;
  byte_order: 'little_endian' | 'big_endian';
  value_type: 'unsigned' | 'signed' | 'float32' | 'float64';
  scale: number;
  offset: number;
  min_val: number | null;
  max_val: number | null;
  unit: string;
  description: string;
  enum_map: Record<number, string>;
  bitfield_map: Record<number, string>;
  default_value: number | string | null;
  constant: boolean;
}

export interface Message {
  id: number;
  name: string;
  direction: 'tx' | 'rx';
  dlc: number;
  description: string;
  node_id_offset: number;
  node_count: number;
  node_id_start: number;
  broadcast_node_id: number | null;
  signals: Signal[];
  crc_extra?: number;
  mux_signal?: string;
}

export interface DeviceConfig {
  name: string;
  version: string;
  description: string;
  bus: string;
  fd: boolean;
  mavlink: boolean;
  bitrate?: number;
  data_bitrate?: number;
  messages: Message[];
}

export interface DecodedSignal {
  name: string;
  raw_value: number;
  physical_value: number;
  enum_name: string | null;
  bitfield_flags: Record<string, boolean> | null;
  unit: string;
  description: string;
}

export interface DecodedMessage {
  msg_id: number;
  name: string;
  description: string;
  signals: DecodedSignal[];
  raw_data: number[];
  node_id: number;
  is_broadcast?: boolean;
  sub_messages?: DecodedMessage[];
}

export interface MavlinkInfo {
  sys_id: number;
  comp_id: number;
  seq?: number;
  msg_id?: number;
  frame_sys_id?: number;
  frame_comp_id?: number;
}

export interface MessageInfo {
  device: string;
  id: string;
  name: string;
  direction: string;
  dlc: number;
  fd: boolean;
  mavlink: boolean;
  signals: string[];
  description: string;
  node_count?: number;
  node_id_offset?: number;
  node_id_start?: number;
  id_range?: string;
  node_range?: string;
  broadcast_id?: string;
}
