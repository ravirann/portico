import { readConfig } from "@/lib/store";
import { SettingsForm } from "@/components/settings-form";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const entries = readConfig({ scope: "global", category: "llm" });
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
  const initial = {
    provider: byKey.provider?.value ?? "",
    model: byKey.model?.value ?? "",
    apiKeyConfigured: Boolean(byKey.api_key),
  };

  return (
    <>
      <div className="topbar"><div className="crumb"><b>Settings</b></div></div>
      <div className="content">
        <div className="page-head rise rise-1">
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            The default model used to resolve locators, refine flows and heal at run time.
            Connectors can override this on their edit page. Secrets are stored locally and never displayed.
          </p>
        </div>
        <div className="rise rise-2">
          <SettingsForm initial={initial} />
        </div>
      </div>
    </>
  );
}
