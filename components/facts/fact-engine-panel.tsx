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

type ArchiveEntry = {
  issue_month: string;
  title: string;
  status: "historical_reconstruction" | "published" | "corrected";
  prepared_at: string;
  path: string;
};

type ArchivedBrief = Omit<ArchiveEntry, "path"> & {
  observation_cutoff: string;
  headline: string;
  summary: string;
  reconstruction_note: string;
  source_packet_sha256: string;
  source_releases: Array<{ provider: string; release: string; sha256: string }>;
  sections: Array<{
    question: string;
    answer: string;
    observation_period: string;
    status: "validated" | "preliminary";
    evidence: string[];
    sources: string;
    caveat: string;
  }>;
};

function generatedDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}

function issueMonth(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T00:00:00Z`));
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
  const [archive, setArchive] = useState<ArchivedBrief[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${basePath}/data/facts/latest.json`)
      .then((response) => {
        if (!response.ok) throw new Error("The current market brief is unavailable.");
        return response.json() as Promise<FactPacket>;
      })
      .then(setPacket)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "The market brief could not be loaded."));

    fetch(`${basePath}/data/briefs/index.json`)
      .then((response) => {
        if (!response.ok) throw new Error("The market brief archive is unavailable.");
        return response.json() as Promise<{ briefs: ArchiveEntry[] }>;
      })
      .then((index) => Promise.all(index.briefs.slice(0, 3).map(async (entry) => {
        const response = await fetch(`${basePath}/data/briefs/${entry.path}`);
        if (!response.ok) throw new Error(`Archived brief ${entry.issue_month} is unavailable.`);
        return response.json() as Promise<ArchivedBrief>;
      })))
      .then(setArchive)
      .catch(() => setArchive([]));
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

      {archive.length > 0 && (
        <section className="brief-archive" aria-labelledby="brief-archive-title">
          <div className="brief-archive-heading">
            <div><p className="section-kicker">Archive</p><h2 id="brief-archive-title">Previous market briefs</h2></div>
            <p>Approved editions retain the evidence, source vintages, and limitations used at preparation. A later correction is labeled rather than silently replacing the original record.</p>
          </div>
          <div className="brief-archive-list">
            {archive.map((brief) => (
              <details className="brief-archive-item" key={brief.issue_month}>
                <summary>
                  <span className="brief-archive-date">{issueMonth(brief.issue_month)}</span>
                  <span className="brief-archive-title"><strong>{brief.headline}</strong><small>{brief.summary}</small></span>
                  <span className={`brief-archive-badge ${brief.status}`}>{brief.status === "historical_reconstruction" ? "Historical reconstruction" : brief.status}</span>
                </summary>
                <div className="brief-archive-body">
                  <p className="brief-reconstruction-note"><AlertCircle /> {brief.reconstruction_note}</p>
                  <div className="brief-archive-sections">
                    {brief.sections.map((section) => (
                      <article key={section.question}>
                        <div className="brief-archive-question"><h3>{section.question}</h3><span className={`brief-status ${section.status === "preliminary" ? "review" : "checked"}`}>{section.status === "preliminary" ? "Preliminary" : "Validated"}</span></div>
                        <p className="brief-answer">{section.answer}</p>
                        <div className="brief-evidence">{section.evidence.map((item) => <p key={item}>{item}</p>)}</div>
                        <p className="brief-archive-source">{section.observation_period} · {section.sources}</p>
                        <p className="brief-archive-caveat">{section.caveat}</p>
                      </article>
                    ))}
                  </div>
                  <details className="brief-audit brief-archive-audit">
                    <summary>Source releases and fingerprint</summary>
                    {brief.source_releases.map((source) => <div key={`${source.provider}-${source.release}`}><p><strong>{source.provider}</strong></p><span>{source.release}</span><code>{source.sha256}</code></div>)}
                    <code>Source fact packet {brief.source_packet_sha256}</code>
                  </details>
                </div>
              </details>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
