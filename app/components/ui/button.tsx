import * as React from "react";

import { cn } from "../../lib/utils";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost";
type ButtonSize = "default" | "sm" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  default:
    "bg-primary text-primary-foreground shadow-lg shadow-primary/25 hover:-translate-y-0.5 hover:brightness-110 focus-visible:ring-ring",
  secondary:
    "bg-accent text-accent-foreground shadow-md shadow-accent/20 hover:-translate-y-0.5 hover:bg-accent/85 focus-visible:ring-ring",
  outline:
    "border border-border/80 bg-background/70 text-foreground shadow-sm hover:-translate-y-0.5 hover:bg-muted/80 focus-visible:ring-ring",
  ghost: "text-foreground hover:bg-muted/80 focus-visible:ring-ring"
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-11 px-4 py-2",
  sm: "h-9 rounded-xl px-3.5 text-xs",
  lg: "h-12 rounded-2xl px-6"
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", type = "button", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex items-center justify-center rounded-2xl text-sm font-semibold transition-all",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          "ring-offset-background disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-50",
          variantClasses[variant],
          sizeClasses[size],
          className
        )}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button };
