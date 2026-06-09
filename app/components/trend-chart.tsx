import { useState } from "react";
import { cn } from "~/lib/utils";

export type TrendPoint = {
  /** Short axis label for this point, e.g. "6/9". */
  label: string;
  /** Numeric value plotted for this point. */
  value: number;
};

// Internal SVG coordinate space. The chart scales to its container via the
// viewBox, so these are arbitrary "design" units, not pixels.
const VIEW_W = 600;
const VIEW_H = 160;
const PAD_X = 10;
const PAD_TOP = 14;
const PAD_BOTTOM = 10;

/**
 * Hand-rolled inline-SVG line/sparkline chart. Rendered server-side from loader
 * data — no charting dependency — with a lightweight hover tooltip that
 * activates after hydration. Color is driven by the parent's text color
 * (`currentColor`), so pass a `text-*` class to recolor it.
 */
export function TrendChart({
  data,
  formatValue = (value) => String(value),
  ariaLabel,
  className,
}: {
  data: TrendPoint[];
  formatValue?: (value: number) => string;
  ariaLabel: string;
  className?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (data.length === 0) return null;

  const maxValue = Math.max(...data.map((point) => point.value), 0);
  // A flat all-zero series still draws a baseline instead of dividing by zero.
  const yScale =
    maxValue === 0 ? 0 : (VIEW_H - PAD_TOP - PAD_BOTTOM) / maxValue;

  const plotW = VIEW_W - PAD_X * 2;
  const stepX = data.length > 1 ? plotW / (data.length - 1) : 0;
  const baselineY = VIEW_H - PAD_BOTTOM;

  const points = data.map((point, i) => ({
    ...point,
    x: PAD_X + stepX * i,
    y: baselineY - point.value * yScale,
  }));

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");
  const areaPath =
    `M ${points[0].x} ${baselineY} ` +
    points.map((p) => `L ${p.x} ${p.y}`).join(" ") +
    ` L ${points[points.length - 1].x} ${baselineY} Z`;

  const active = hovered === null ? null : points[hovered];

  return (
    <div className={cn("relative text-primary", className)}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={ariaLabel}
      >
        {/* Soft area under the line. */}
        <path d={areaPath} fill="currentColor" fillOpacity={0.08} />
        {/* The trend line itself. */}
        <path
          d={linePath}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {/* Hover guide + emphasized dot for the active point. */}
        {active && (
          <>
            <line
              x1={active.x}
              y1={PAD_TOP}
              x2={active.x}
              y2={baselineY}
              stroke="currentColor"
              strokeOpacity={0.25}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={active.x} cy={active.y} r={4} fill="currentColor" />
          </>
        )}

        {/* Transparent hit bands — one per point — drive the hover state. */}
        {points.map((p, i) => (
          <rect
            key={i}
            x={p.x - stepX / 2}
            y={0}
            width={stepX || plotW}
            height={VIEW_H}
            fill="transparent"
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </svg>

      {/* Range labels: first and last buckets. */}
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{data[0].label}</span>
        <span>{data[data.length - 1].label}</span>
      </div>

      {/* Lightweight hover tooltip (progressive enhancement). */}
      {active && (
        <div
          className="pointer-events-none absolute top-0 -translate-x-1/2 -translate-y-1 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: `${(active.x / VIEW_W) * 100}%` }}
        >
          <span className="font-medium text-popover-foreground">
            {formatValue(active.value)}
          </span>
          <span className="ml-1.5 text-muted-foreground">{active.label}</span>
        </div>
      )}
    </div>
  );
}
