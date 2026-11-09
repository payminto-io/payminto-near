import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("relative overflow-hidden rounded-md bg-accent/70 after:absolute after:inset-0 after:-translate-x-full after:animate-[shimmer_1.2s_linear_infinite] after:bg-gradient-to-r after:from-transparent after:via-background/50 after:to-transparent", className)}
      {...props}
    />
  )
}

export { Skeleton }
