import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { Star } from "lucide-react";
import { cn } from "~/lib/utils";

const STARS = [1, 2, 3, 4, 5];

function sizeClass(size: "sm" | "md" | "lg") {
  return size === "lg" ? "size-6" : size === "md" ? "size-5" : "size-4";
}

/**
 * Read-only average rating: stars + numeric average + count.
 * Renders "No ratings yet" when there are no ratings.
 */
export function StarRatingDisplay({
  average,
  count,
  size = "sm",
  className,
}: {
  average: number;
  count: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  if (count === 0) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        No ratings yet
      </span>
    );
  }

  return (
    <span
      className={cn("flex items-center gap-1.5", className)}
      aria-label={`Rated ${average.toFixed(1)} out of 5 from ${count} ${
        count === 1 ? "rating" : "ratings"
      }`}
    >
      <span className="flex items-center">
        {STARS.map((star) => (
          <Star
            key={star}
            className={cn(
              sizeClass(size),
              star <= Math.round(average)
                ? "fill-yellow-400 text-yellow-400"
                : "fill-none text-muted-foreground/40"
            )}
          />
        ))}
      </span>
      <span className="text-sm font-medium text-foreground">
        {average.toFixed(1)}
      </span>
      <span className="text-xs text-muted-foreground">({count})</span>
    </span>
  );
}

/**
 * Interactive star picker for enrolled students. Submits the rating to
 * /api/course-review and can be changed at any time.
 */
export function StarRatingInput({
  courseId,
  currentRating,
  size = "lg",
}: {
  courseId: number;
  currentRating: number | null;
  size?: "sm" | "md" | "lg";
}) {
  const fetcher = useFetcher<{ success: boolean; rating: number }>();
  const [hovered, setHovered] = useState<number | null>(null);

  // Optimistic value while a JSON submission is in flight.
  const pending =
    fetcher.state !== "idle" && fetcher.json
      ? ((fetcher.json as { rating?: number }).rating ?? null)
      : null;
  const selected = currentRating;
  const active = hovered ?? pending ?? selected ?? 0;

  function submit(rating: number) {
    fetcher.submit(
      { courseId, rating },
      {
        method: "post",
        action: "/api/course-review",
        encType: "application/json",
      }
    );
  }

  // Surface a confirmation / error once the submission settles.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        toast.success("Thanks for rating this course!");
      } else {
        toast.error("Could not save your rating. Please try again.");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  return (
    <div className="flex items-center gap-3">
      <div
        className="flex items-center"
        onMouseLeave={() => setHovered(null)}
        role="radiogroup"
        aria-label="Rate this course"
      >
        {STARS.map((star) => (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={selected === star}
            aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
            className="rounded-sm p-0.5 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onMouseEnter={() => setHovered(star)}
            onClick={() => submit(star)}
            disabled={fetcher.state !== "idle"}
          >
            <Star
              className={cn(
                sizeClass(size),
                star <= active
                  ? "fill-yellow-400 text-yellow-400"
                  : "fill-none text-muted-foreground/40"
              )}
            />
          </button>
        ))}
      </div>
      {selected ? (
        <span className="text-sm text-muted-foreground">
          Your rating: {selected}/5
        </span>
      ) : (
        <span className="text-sm text-muted-foreground">
          Tap a star to rate
        </span>
      )}
    </div>
  );
}
