import * as React from "react";

import { cn } from "../../lib/utils";

type BadgeVariant = "default" | "outline" | "success" | "warning";

const variantClasses: Record<BadgeVariant, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  outline: "border-border text-foreground",
  success: "border-transparent bg-success/20 text-success",
  warning: "border-transparent bg-warning/20 text-warning"
};

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide",
        variantClasses[variant],
        className
      )}
      {...props}
    />
  );
}

export { Badge };
