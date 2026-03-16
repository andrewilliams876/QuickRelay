import * as React from "react";

import { cn } from "../../lib/utils";

type BadgeVariant = "default" | "outline" | "success" | "warning";

const variantClasses: Record<BadgeVariant, string> = {
  default: "border-transparent bg-primary/12 text-primary",
  outline: "border-border/80 bg-background/70 text-foreground/80",
  success: "border-transparent bg-success/15 text-success",
  warning: "border-transparent bg-warning/15 text-warning"
};

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold tracking-[0.02em] shadow-sm",
        variantClasses[variant],
        className
      )}
      {...props}
    />
  );
}

export { Badge };
