import { useState } from "react";
import { cn } from "~/lib/utils";

export type BarChartDatum = {
  /** Short axis label rendered under the bar, e.g. a lesson number or band. */
  label: string;
  /** Bar height value. */
  value: number;
  /** Emphasize this bar in a warning color (e.g. the biggest drop-off lesson). */
  highlight?: boolean;
  /** Secondary text for the hover tooltip; falls back to `label` when absent. */
  tooltip?: string;
};

// Internal SVG coordinate space. The chart scales to its container via the
// viewBox, so these are arbitrary "design" units, not pixels.
const VIEW_W = 600;
const VIEW_H = 160;
const PAD_X = 10;
const PAD_TOP = 14;
const PAD_BOTTOM = 10;
// Fraction of each evenly-sized slot left as gap between bars.
const BAR_GAP_RATIO = 0.3;

/**
 * Hand-rolled inline-SVG vertical bar chart. Rendered server-side from loader
 * data — no charting dependency — with a lightweight hover tooltip that
 * activates after hydration. Color is driven by the parent's text color
 * (`currentColor`), so pass a `text-*` class to recolor it; a highlighted bar
 * overrides that with an amber accent. Reused by the lesson-completion funnel
 * and the per-quiz score histograms.
 */
export function BarChart({
  data,
  maxValue,
  formatValue = (value) => String(value),
  ariaLabel,
  className,
}: {
  data: BarChartDatum[];
  /** Fixed top of the value scale; defaults to the largest value in `data`. */
  maxValue?: number;
  formatValue?: (value: number) => string;
  ariaLabel: string;
  className?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (data.length === 0) return null;

  const max = Math.max(maxValue ?? 0, ...data.map((d) => d.value));
  // A flat all-zero series still draws a baseline instead of dividing by zero.
  const yScale = max === 0 ? 0 : (VIEW_H - PAD_TOP - PAD_BOTTOM) / max;

  const plotW = VIEW_W - PAD_X * 2;
  const slotW = plotW / data.length;
  const barW = slotW * (1 - BAR_GAP_RATIO);
  const baselineY = VIEW_H - PAD_BOTTOM;

  const bars = data.map((d, i) => {
    const height = d.value * yScale;
    const slotX = PAD_X + slotW * i;
    return {
      ...d,
      x: slotX + (slotW - barW) / 2,
      y: baselineY - height,
      width: barW,
      height,
      center: slotX + slotW / 2,
    };
  });

  const active = hovered === null ? null : bars[hovered];

  return (
    <div className={cn("relative text-primary", className)}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={ariaLabel}
      >
        {/* Baseline the bars sit on. */}
        <line
          x1={PAD_X}
          y1={baselineY}
          x2={VIEW_W - PAD_X}
          y2={baselineY}
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        {bars.map((bar, i) => (
          <rect
            key={i}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={Math.max(bar.height, 0)}
            rx={2}
            fill="currentColor"
            fillOpacity={bar.highlight ? 0.95 : hovered === i ? 0.85 : 0.5}
            className={
              bar.highlight ? "text-amber-600 dark:text-amber-500" : undefined
            }
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </svg>

      {/* Per-bar axis labels, one equal cell under each slot. */}
      <div className="mt-1 flex text-xs text-muted-foreground">
        {data.map((d, i) => (
          <span key={i} className="flex-1 truncate text-center">
            {d.label}
          </span>
        ))}
      </div>

      {/* Lightweight hover tooltip (progressive enhancement). */}
      {active && (
        <div
          className="pointer-events-none absolute top-0 -translate-x-1/2 -translate-y-1 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: `${(active.center / VIEW_W) * 100}%` }}
        >
          <span className="font-medium text-popover-foreground">
            {formatValue(active.value)}
          </span>
          <span className="ml-1.5 text-muted-foreground">
            {active.tooltip ?? active.label}
          </span>
        </div>
      )}
    </div>
  );
}
