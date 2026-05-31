export interface FrameRef {
  id: number;
  data: number[];
  timestamp: number;
  is_fd: boolean;
  direction?: 'rx' | 'tx';
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

// User-defined formula. `vars` binds each identifier used in `expr` to an
// existing signal key (e.g. "MotorFeedback / position"). Multi-var formulas
// align values by time using sample-and-hold on each variable's latest value.
//
// When `perNode` is true, var values may use the placeholder "N*" in the
// node-id slot (e.g. "MotorFeedback / N* / position"). The store expands the
// formula to one derived series per node where every templated binding resolves
// (i.e. intersection of nodes available for each var). Var values without "N*"
// are static — that signal is reused for every per-node instance.
export interface DerivedSignal {
  id: string;
  name: string;
  expr: string;
  unit: string;
  vars: Record<string, string>;
  perNode?: boolean;
}

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
    formulas?: DerivedSignal[];
  };
}
