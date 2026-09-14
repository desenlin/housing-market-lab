"use client";

import { Children, useId, useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function MethodCard({ title, children }: { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <Card className={`method-card ${expanded ? "is-expanded" : "is-collapsed"}`}>
    <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
    <CardContent className="method-card-body">
      <div id={id} className={`method-copy ${expanded ? "" : "method-preview"}`}>
        {expanded ? children : Children.toArray(children)[0]}
      </div>
      <Button variant="ghost" className="method-toggle" aria-expanded={expanded} aria-controls={id} aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`} onClick={() => setExpanded(value => !value)}>
        {expanded ? "Collapse" : "Expand"}
      </Button>
    </CardContent>
  </Card>;
}
