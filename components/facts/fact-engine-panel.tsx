"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Database, FlaskConical, Link2, ListChecks, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Fact = {
  id: string;
  domain: string;
  provider: string;
  release: string;
  metric: string;
  metric_label: string;
  geography: string;
  period: string;
  value_display: string;
  change_display: string;
  comparison: string;
  direction: string;
  material: boolean;
  score: number;
  confidence: "high" | "review";
  coverage: string;
  evidence: string;
  caveat: string | null;
  provisional: boolean;
};

type FactPacket = {
  status: string;
  generated_at: string;
  data_cutoff: string;
  method: string;
  packet_sha256: string;
  summary: { candidates: number; material: number; high_confidence: number; review_required: number };
  facts: Fact[];
};

type BriefQuestion = {
  kicker: string;
  question: string;
  answer: string;
  facts: Fact[];
  destination: string;
  linkLabel: string;
};

function generatedDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}

function findFact(packet: FactPacket, metric: string) {
  return packet.facts.find((item) => item.metric === metric);
}

function EvidenceStatus({ facts }: { facts: Fact[] }) {
  const requiresReview = facts.some((item) => item.confidence === "review");
  return (
    <span className={`brief-status ${requiresReview ? "review" : "checked"}`}>
      {requiresReview ? <AlertCircle /> : <CheckCircle2 />}
      {requiresReview ? "Preliminary—review required" : "Validated evidence"}
    </span>
  );
}

function Standard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="brief-standard"><span>{icon}</span><div><strong>{title}</strong><p>{children}</p></div></div>;
}

export function FactEnginePanel({ basePath, onNavigate }: { basePath: string; onNavigate: (tab: string) => void }) {
  const [packet, setPacket] = useState<FactPacket | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${basePath}/data/facts/latest.json`)
      .then((response) => {
        if (!response.ok) throw new Error("The current market brief is unavailable.");
        return response.json() as Promise<FactPacket>;
      })
      .then(setPacket)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "The market brief could not be loaded."));
  }, [basePath]);

  const questions = useMemo<BriefQuestion[]>(() => {
    if (!packet) return [];
    const realPrice = findFact(packet, "real_zhvi");
    const rent = findFact(packet, "zori");
    const inventory = findFact(packet, "inventory");
    const permits = packet.facts.filter((item) => item.metric === "permits_ytd");
    const output: BriefQuestion[] = [];

    if (realPrice) output.push({
      kicker: "Prices after inflation",
      question: "Are home values keeping pace with local inflation?",
      answer: `No. Los Angeles metro home values changed ${realPrice.change_display} after adjusting for LA-area CPI-U.`,
      facts: [realPrice], destination: "local", linkLabel: "Explore prices and rents",
    });
    if (permits.length) output.push({
      kicker: "Construction pipeline",
      question: "Is residential permitting increasing?",
      answer: permits.map((item) => `${item.geography.replace(" County", "")}: ${item.change_display}`).join(" · "),
      facts: permits, destination: "permits", linkLabel: "Explore building permits",
    });
    if (inventory) output.push({
      kicker: "Homes available for sale",
      question: "Has metropolitan inventory shifted materially?",
      answer: inventory.material
        ? `Yes. Los Angeles metro inventory changed ${inventory.change_display} from one year earlier.`
        : `Not under the current reporting rule. Inventory changed ${inventory.change_display}, below the 5% materiality threshold.`,
      facts: [inventory], destination: "activity", linkLabel: "Explore market conditions",
    });
    if (rent) output.push({
      kicker: "Asking rents",
      question: "Are asking rents accelerating?",
      answer: rent.material
        ? `Typical asking rent changed ${rent.change_display} from one year earlier.`
        : `No material acceleration is detected. Typical asking rent changed ${rent.change_display} from one year earlier.`,
      facts: [rent], destination: "local", linkLabel: "Explore rent trends",
    });
    return output;
  }, [packet]);

  if (error) return <section className="fact-status"><AlertCircle /> {error}</section>;
  if (!packet) return <section className="fact-status"><FlaskConical /> Preparing the current market brief…</section>;

  return (
    <div className="market-brief-stack">
      <section className="market-brief-header">
        <div>
          <p className="section-kicker">Latest market brief</p>
          <h2>What do the newest releases say about the market?</h2>
          <p className="brief-date">Evidence available as of {generatedDate(packet.generated_at)}</p>
        </div>
        <p>This brief answers a small set of recurring market questions. It reports material changes, identifies when the evidence is preliminary, and links every conclusion to the underlying data.</p>
      </section>

      <section className="brief-question-grid" aria-label="Current market questions">
        {questions.map((item, index) => (
          <Card className="brief-question-card" key={item.question}>
            <CardHeader>
              <div className="brief-question-number">{String(index + 1).padStart(2, "0")}</div>
              <div><p className="section-kicker">{item.kicker}</p><CardTitle>{item.question}</CardTitle></div>
            </CardHeader>
            <CardContent>
              <p className="brief-answer">{item.answer}</p>
              <div className="brief-source-row"><EvidenceStatus facts={item.facts} /><span>{[...new Set(item.facts.map((fact) => fact.provider))].join(" · ")}</span></div>
              <div className="brief-evidence">
                {item.facts.map((fact) => <p key={fact.id}><strong>{fact.geography}:</strong> {fact.evidence}</p>)}
              </div>
              <div className="brief-card-footer">
                <Button variant="outline" onClick={() => onNavigate(item.destination)}>{item.linkLabel} <ArrowRight /></Button>
                <details className="brief-audit"><summary>Evidence and limitations</summary>{item.facts.map((fact) => <div key={fact.id}><p>{fact.caveat}</p><span>{fact.period} · {fact.coverage}</span><code>{fact.release}</code></div>)}</details>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card className="brief-standard-card">
        <CardHeader><p className="section-kicker">Why this brief is different</p><CardTitle>Evidence is checked before prose is written.</CardTitle></CardHeader>
        <CardContent className="brief-standards">
          <Standard icon={<ShieldCheck />} title="Release-aware quality control">Only validated provider releases enter the brief. Missing coverage, preliminary observations, incompatible periods, and provider flags alter or block conclusions.</Standard>
          <Standard icon={<ListChecks />} title="Questions before variables">The brief answers recurring questions about prices, rents, availability, liquidity, and construction instead of describing every series simply because it exists.</Standard>
          <Standard icon={<Link2 />} title="Direct evidentiary support">Every claim retains its observation period, calculation, source release, coverage, and limitations. An unconstrained AI summary cannot provide this assurance from prose alone.</Standard>
        </CardContent>
      </Card>

      <details className="brief-method-note">
        <summary><Database /> How the evidence layer works</summary>
        <p>A deterministic engine evaluated {packet.summary.candidates} valid comparisons and identified {packet.summary.material} that exceeded metric-specific materiality thresholds. Priority scores and candidate diagnostics remain behind this public brief; they do not determine causality or produce forecasts.</p>
        <code>Fact packet {packet.packet_sha256}</code>
      </details>
    </div>
  );
}
