"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ResponsiveContainer } from "recharts";

/** Wait for a visible layout before mounting Recharts, including on tab changes. */
export function MeasuredChart({ children }: {
  children: ComponentProps<typeof ResponsiveContainer>["children"];
}) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      setSize((previous) => previous.width === width && previous.height === height
        ? previous : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={container} className="h-full w-full min-w-0" data-measured-chart>
      {size.width > 0 && size.height > 0 && (
        <ResponsiveContainer width={size.width} height={size.height}>
          {children}
        </ResponsiveContainer>
      )}
    </div>
  );
}
