export interface FrameRef {
  id: number;
  data: number[];
  timestamp: number;
  is_fd: boolean;
  extraFrames?: { data: number[]; timestamp: number }[];
}

export interface SignalSample {
  time: number;
  value: number;
  frame: FrameRef;
}

export interface SignalSeries {
  key: string;
  group: string;
  signal: string;
  unit: string;
  samples: SignalSample[];
}

export interface ChartPanel {
  id: string;
  keys: string[];
}

export interface MessageTimingEntry {
  time: number;
  frame: FrameRef;
}

export type InputMode = 'paste' | 'live';
export type ChartView = 'signals' | 'timeline' | 'interval';
export type BufferMode = 'unlimited' | 'samples' | 'time';

export interface PlotLayoutConfig {
  plot: {
    views?: {
      active?: ChartView[];
      order?: ChartView[];
    };
    buffer?: {
      mode?: BufferMode;
      samples?: number;
      seconds?: number;
    };
    signals?: {
      panels: string[][];
    };
    intervals?: {
      panels: string[][];
    };
  };
}
