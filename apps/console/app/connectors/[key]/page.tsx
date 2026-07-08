import Link from "next/link";
import { notFound } from "next/navigation";
import { readConnector, readConfig } from "@/lib/store";
import { ConnectorEditor } from "@/components/connector-editor";

export const dynamic = "force-dynamic";

export default async function ConnectorEditPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const isNew = key === "new";

  const connector = isNew ? undefined : readConnector(key);
  if (!isNew && !connector) notFound();

  // Per-connector LLM override state. Never surface the stored secret value —
  // only whether the api key is configured.
  const llmEntries = isNew ? [] : readConfig({ scope: key, category: "llm" });
  const byKey = Object.fromEntries(llmEntries.map((e) => [e.key, e]));
  const llm = {
    provider: byKey.provider?.value ?? "",
    model: byKey.model?.value ?? "",
    apiKeyConfigured: Boolean(byKey.api_key),
  };

  // Default-environment variables, pre-loaded so the editor renders without a
  // client fetch flash. Scope is `<key>:default`; secrets come back masked.
  const varEntries = isNew ? [] : readConfig({ scope: `${key}:default`, category: "variable" });
  const initialVars = varEntries.map((e) => ({
    key: e.key,
    value: e.secret ? "" : e.value,
    secret: e.secret,
    configured: e.secret,
  }));

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <Link href="/connectors">Connectors</Link> <span>/</span>{" "}
          <b>{isNew ? "New connector" : connector!.name}</b>
        </div>
      </div>
      <div className="content" style={{ maxWidth: 860 }}>
        <div className="page-head rise rise-1">
          <h1 className="page-title" style={{ fontSize: 30 }}>{isNew ? "New connector" : connector!.name}</h1>
          <p className="page-sub">
            {isNew
              ? "Define a target site, its auth strategy and any variables its flows reference."
              : "Edit this connector's details, variables and per-connector LLM override."}
          </p>
        </div>

        <div className="rise rise-2">
          <ConnectorEditor
            initial={
              connector
                ? {
                    key: connector.key,
                    name: connector.name,
                    framework: connector.framework,
                    baseUrl: connector.baseUrl,
                    auth: connector.auth,
                  }
                : undefined
            }
            initialVars={initialVars}
            llm={llm}
          />
        </div>
      </div>
    </>
  );
}
