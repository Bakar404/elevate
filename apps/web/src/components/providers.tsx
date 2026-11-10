"use client";

import { Tooltip } from "@base-ui/react/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  return <Tooltip.Provider delay={400}>{children}</Tooltip.Provider>;
}
