import type { ChartType } from 'chart.js';

declare module 'chart.js' {
  interface PluginOptionsByType<TType extends ChartType> {
    timelineMarkers?: { isTimelineView?: boolean };
  }
}
