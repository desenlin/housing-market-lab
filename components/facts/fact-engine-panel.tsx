"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, ArrowRight, Database, FlaskConical, Link2, ListChecks, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Qualification = { id: string; label: string; explanation: string };
type SourceRelease = { provider: string; release: string; sha256?: string };
type BriefSection = {
  question_id?: string; kicker?: string; question: string; topic?: string; answer: string;
  trigger_fact_id?: string; trigger_fact_ids?: string[]; fact_ids: string[];
  period_end: string; observation_period: string; status: "validated" | "preliminary";
  evidence: string[]; sources: string; source_releases?: SourceRelease[];
  coverage?: string; caveat?: string | null; destination?: string; link_label?: string;
  qualifications?: Qualification[];
};
type CurrentBrief = {
  status: "automatic_snapshot"; generated_at: string; data_cutoff: string;
  source_packet_sha256: string; method: string;
  monitoring: { question_count: number; qualified_before_editorial_cap: number; displayed_findings: number; suppressed_related_findings: number };
  source_releases: SourceRelease[]; sections: BriefSection[];
};
type ArchiveEntry = {
  issue_month: string; title: string; status: "historical_reconstruction" | "published" | "corrected";
  prepared_at: string; path: string;
};
type ArchivedBrief = Omit<ArchiveEntry, "path"> & {
  observation_cutoff: string; headline: string; summary: string; reconstruction_note: string;
  source_packet_sha256: string; source_releases: SourceRelease[]; sections: BriefSection[];
};

function generatedDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}
function issueMonth(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T00:00:00Z`));
}
async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}
function Standard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="brief-standard"><span>{icon}</span><div><strong>{title}</strong><p>{children}</p></div></div>;
}
function QualificationList({ qualifications = [] }: { qualifications?: Qualification[] }) {
  if (!qualifications.length) return null;
  return <div className="brief-qualifications" aria-label="Why this finding qualified">
    {qualifications.map((rule) => <span key={rule.id} title={rule.explanation}>{rule.label}</span>)}
  </div>;
}

export function FactEnginePanel({ basePath, onNavigate }: { basePath: string; onNavigate: (tab: string) => void }) {
  const [current, setCurrent] = useState<CurrentBrief | null>(null);
  const [archive, setArchive] = useState<ArchivedBrief[]>([]);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void getJson<CurrentBrief>(`${basePath}/data/briefs/current.json`, controller.signal)
      .then(setCurrent)
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unknown loading error");
      });
    void getJson<{ briefs: ArchiveEntry[] }>(`${basePath}/data/briefs/index.json`, controller.signal)
      .then((index) => Promise.all(index.briefs.slice(0, 3).map((entry) =>
        getJson<ArchivedBrief>(`${basePath}/data/briefs/${entry.path}`, controller.signal)
      )))
      .then(setArchive)
      .catch(() => { if (!controller.signal.aborted) setArchive([]); });
    return () => controller.abort();
  }, [basePath, reloadKey]);

  if (error) return <section className="fact-status" role="alert"><AlertCircle /> The current evidence snapshot could not be loaded ({error}). <Button variant="outline" onClick={() => { setError(""); setCurrent(null); setReloadKey((value) => value + 1); }}>Try again</Button></section>;
  if (!current) return <section className="fact-status" role="status"><FlaskConical /> Preparing the current evidence snapshot…</section>;

  return <div className="market-brief-stack">
    <section className="market-brief-header">
      <div>
        <p className="section-kicker">Current evidence snapshot</p>
        <h2>What qualifies for attention in the newest releases?</h2>
        <p className="brief-date">Evidence available as of {generatedDate(current.generated_at)}</p>
      </div>
      <p>This automatic screen publishes only findings that meet a pre-specified rule. Meaningful does not mean statistically rare: a finding may qualify through material movement, a broad local shift, a direction change, or disagreement between related indicators. An archived brief still requires maintainer review.</p>
    </section>

    {current.sections.length ? <section className="brief-question-grid" aria-label="Current qualified findings">
      {current.sections.map((item, index) => <Card className="brief-question-card" key={item.question_id ?? item.question}>
        <CardHeader>
          <div className="brief-question-number">{String(index + 1).padStart(2, "0")}</div>
          <div><p className="section-kicker">{item.kicker ?? "Qualified finding"}</p><CardTitle>{item.question}</CardTitle></div>
        </CardHeader>
        <CardContent>
          <QualificationList qualifications={item.qualifications} />
          <p className="brief-answer">{item.answer}</p>
          <div className="brief-source-row">
            <span>{item.sources}</span>
            <span className={`brief-status ${item.status === "preliminary" ? "review" : "checked"}`}>
              {item.status === "preliminary" ? <AlertCircle /> : <ShieldCheck />}
              {item.status === "preliminary" ? "Preliminary" : "Validated"}
            </span>
          </div>
          <div className="brief-evidence">{item.evidence.map((evidence) => <p key={evidence}>{evidence}</p>)}</div>
          <div className="brief-card-footer">
            {item.destination && <Button variant="outline" onClick={() => onNavigate(item.destination!)}>{item.link_label ?? "Explore the evidence"} <ArrowRight /></Button>}
            <details className="brief-audit">
              <summary>Evidence and limitations</summary>
              <div>
                {item.qualifications?.map((rule) => <p key={rule.id}><strong>{rule.label}:</strong> {rule.explanation}</p>)}
                {item.coverage && <p><strong>Coverage:</strong> {item.coverage}</p>}
                {item.caveat && <p>{item.caveat}</p>}
                <span>{item.observation_period}</span>
                {item.source_releases?.map((source) => <code key={`${source.provider}-${source.release}`}>{source.provider} · {source.release}</code>)}
                <code>Facts: {item.fact_ids.join(", ")}</code>
              </div>
            </details>
          </div>
        </CardContent>
      </Card>)}
    </section> : <p className="fact-empty">No finding in the current evidence pool met a reporting rule. That is an informative result, not a loading failure.</p>}

    <Card className="brief-standard-card">
      <CardHeader><p className="section-kicker">Editorial design</p><CardTitle>Questions before variables, with explicit selection rules.</CardTitle></CardHeader>
      <CardContent className="brief-standards">
        <Standard icon={<ShieldCheck />} title="Multiple ways to qualify">Fixed thresholds are only one route. Breadth, turns, and pre-specified indicator disagreements can surface informative developments that are not tail events.</Standard>
        <Standard icon={<ListChecks />} title="Expandable internal registry">The hidden question pool spans prices, rents, availability, market speed, seller adjustment, competition, listing flows, and construction. It can grow without turning each edition into a dashboard.</Standard>
        <Standard icon={<Link2 />} title="Direct evidentiary support">Every published claim retains its period, calculation, source release, coverage, limitations, and fact identifiers. No rule assigns causality or forecasts the market.</Standard>
      </CardContent>
    </Card>

    <details className="brief-method-note">
      <summary><Database /> How the evidence screen works</summary>
      <p>The engine evaluated {current.monitoring.question_count} internal questions. {current.monitoring.qualified_before_editorial_cap} qualified, {current.monitoring.displayed_findings} appear here, and {current.monitoring.suppressed_related_findings} related finding{current.monitoring.suppressed_related_findings === 1 ? " was" : "s were"} withheld by the four-finding, one-per-theme editorial cap. These are deterministic editorial screens—not tail probabilities, hypothesis tests, causal claims, or forecasts.</p>
      <code>Fact packet {current.source_packet_sha256}</code>
    </details>

    {archive.length > 0 && <section className="brief-archive" aria-labelledby="brief-archive-title">
      <div className="brief-archive-heading">
        <div><p className="section-kicker">Archive</p><h2 id="brief-archive-title">Reviewed market briefs</h2></div>
        <p>Approved editions retain the evidence, source vintages, wording, and limitations used at publication. The August reconstruction remains intact; later corrections are labeled instead of silently replacing the record.</p>
      </div>
      <div className="brief-archive-list">
        {archive.map((brief) => <details className="brief-archive-item" key={brief.issue_month}>
          <summary>
            <span className="brief-archive-date">{issueMonth(brief.issue_month)}</span>
            <span className="brief-archive-title"><strong>{brief.headline}</strong><small>{brief.summary}</small></span>
            <span className={`brief-archive-badge ${brief.status}`}>{brief.status === "historical_reconstruction" ? "Historical reconstruction" : brief.status}</span>
          </summary>
          <div className="brief-archive-body">
            <p className="brief-reconstruction-note"><AlertCircle /> {brief.reconstruction_note}</p>
            <div className="brief-archive-sections">
              {brief.sections.map((section) => <article key={section.question_id ?? section.question}>
                <div className="brief-archive-question"><h3>{section.question}</h3></div>
                <QualificationList qualifications={section.qualifications} />
                <p className="brief-answer">{section.answer}</p>
                <div className="brief-evidence">{section.evidence.map((evidence) => <p key={evidence}>{evidence}</p>)}</div>
                <p className="brief-archive-source">{section.observation_period} · {section.sources}</p>
                {section.coverage && <p className="brief-archive-coverage"><strong>Coverage:</strong> {section.coverage}</p>}
                {section.caveat && <p className="brief-archive-caveat">{section.caveat}</p>}
              </article>)}
            </div>
            <details className="brief-audit brief-archive-audit">
              <summary>Source releases and fingerprint</summary>
              {brief.source_releases.map((source) => <div key={`${source.provider}-${source.release}`}><p><strong>{source.provider}</strong></p><span>{source.release}</span>{source.sha256 && <code>{source.sha256}</code>}</div>)}
              <code>Source fact packet {brief.source_packet_sha256}</code>
            </details>
          </div>
        </details>)}
      </div>
    </section>}
  </div>;
}
