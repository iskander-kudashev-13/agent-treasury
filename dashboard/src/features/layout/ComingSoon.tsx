import type { ReactNode } from "react";
import { Card, EmptyState } from "@/kit";

/** Placeholder body for screens that are not built yet. Replace the page content, keep the route. */
export function ComingSoon({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <Card padding="none">
      <EmptyState title={title} action={action}>
        {children}
      </EmptyState>
    </Card>
  );
}
