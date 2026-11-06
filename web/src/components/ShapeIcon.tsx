import type { Shape } from "@/lib/view";

interface Props {
  shape: Shape;
  size?: number;
  fill?: string;
  stroke?: string;
}

export function ShapeIcon({ shape, size = 12, fill = "none", stroke = "var(--ink-2)" }: Props) {
  const common = { fill, stroke, strokeWidth: 1.5 };
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      {shape === "circle" && <circle cx="6" cy="6" r="4.25" {...common} />}
      {shape === "square" && <rect x="2" y="2" width="8" height="8" {...common} />}
      {shape === "diamond" && <path d="M6 .9 11.1 6 6 11.1.9 6Z" {...common} />}
      {shape === "triangle" && <path d="M6 1.4 10.9 10H1.1Z" {...common} />}
    </svg>
  );
}
