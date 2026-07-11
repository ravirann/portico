import Link from "next/link";
import { cookies } from "next/headers";
import { readConnectors, readSessions } from "@/lib/store";
import { listConnectors } from "@/lib/connectors";
import { NewFlow } from "@/components/new-flow";
import type { ConnectorOption } from "@/components/new-flow-editor";
import type { ActiveSession } from "@/components/record-flow";

export const dynamic = "force-dynamic";

export default async function NewFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ connector?: string }>;
}) {
  const { connector } = await searchParams;

  // DB-backed connectors first (editable), then the read-only seed connectors —
  // deduped by key so a seed that's been imported doesn't appear twice.
  const dbKeys = new Set<string>();
  const options: ConnectorOption[] = [];
  for (const c of readConnectors()) {
    dbKeys.add(c.key);
    options.push({ key: c.key, name: c.name, editable: true, sector: c.sector });
  }
  for (const c of listConnectors()) {
    if (dbKeys.has(c.key)) continue;
    options.push({ key: c.key, name: c.name, editable: false, sector: c.sector });
  }

  // Preselect from ?connector=, else the connector switcher's current scope.
  const scope = (await cookies()).get("portico-connector")?.value?.trim();
  const preselect =
    (connector && options.some((o) => o.key === connector) && connector) ||
    (scope && scope !== "all" && options.some((o) => o.key === scope) && scope) ||
    "";

  // Active CDP sessions the recorder can attach to.
  const sessions: ActiveSession[] = readSessions()
    .filter((s) => s.status === "active" && s.cdpEndpoint)
    .map((s) => ({ id: s.id, tenant: s.tenant, profile: s.profile, cdpEndpoint: s.cdpEndpoint }));

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <Link href="/flows">Flows</Link> <span>/</span> <b>New flow</b>
        </div>
      </div>
      <div className="content" style={{ maxWidth: 900 }}>
        <div className="page-head rise rise-1">
          <h1 className="page-title" style={{ fontSize: 30 }}>New flow</h1>
          <p className="page-sub">
            Describe a goal in plain language. Portico plans it, an agent performs it once on your live
            session, and freezes the run into a version-1 draft to verify, validate and confirm.
          </p>
        </div>
        <div className="rise rise-2">
          <NewFlow connectors={options} sessions={sessions} initialConnector={preselect} />
        </div>
      </div>
    </>
  );
}
