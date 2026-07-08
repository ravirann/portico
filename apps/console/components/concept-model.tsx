import { IconConnectors, IconLayers, IconFlows, IconRuns } from "./icons";

/**
 * The vocabulary map. Portico has exactly four nouns and they nest in one
 * direction — this makes that explicit so "connector vs instance vs flow vs run"
 * is never ambiguous. Rendered on the Overview and the New-flow page.
 */
const CONCEPTS = [
  {
    term: "Connector",
    Icon: IconConnectors,
    gloss: "The kind of portal + how to automate it — target site, auth strategy, variables. Authored once, reused everywhere.",
    eg: "e.g. “Epic MyChart”",
  },
  {
    term: "Instance",
    Icon: IconLayers,
    gloss: "One real deployment of a connector: a specific URL with its own credentials and 2-factor setup. One per environment or organization.",
    eg: "e.g. urmc · mychart.urmc.rochester.edu",
  },
  {
    term: "Flow",
    Icon: IconFlows,
    gloss: "A versioned automation — the steps. Written against a connector, runs unchanged against any of its instances. Draft → validated → confirmed.",
    eg: "e.g. “portal-availability” v3",
  },
  {
    term: "Run",
    Icon: IconRuns,
    gloss: "One execution: a flow, run against one instance, producing outputs and an audit trail.",
    eg: "e.g. 12 slots harvested · 2.1s",
  },
];

export function ConceptModel() {
  return (
    <section className="concepts" aria-label="How Portico is organized">
      <div className="concepts-head">
        <div className="eyebrow">How Portico is organized</div>
        <p className="concepts-lede">
          A <b>flow</b> is authored against a <b>connector</b> and executed against one of its{" "}
          <b>instances</b> — each execution is a <b>run</b>.
        </p>
      </div>
      <ol className="concept-grid">
        {CONCEPTS.map(({ term, Icon, gloss, eg }, i) => (
          <li key={term} className="concept-card">
            <div className="concept-top">
              <span className="concept-ico"><Icon className="ico-sm" /></span>
              <span className="concept-term">{term}</span>
              {i < CONCEPTS.length - 1 && <span className="concept-arrow" aria-hidden>→</span>}
            </div>
            <p className="concept-gloss">{gloss}</p>
            <div className="concept-eg mono">{eg}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}
