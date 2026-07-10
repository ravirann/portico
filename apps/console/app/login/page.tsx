import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

// Never gated by middleware (see lib/rbac.ts isAlwaysAllowedPath) — this is
// the one page that must always render so a token can be presented at all.
export default function LoginPage() {
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Log in</b></div>
      </div>
      <div className="content">
        <div className="page-head rise rise-1">
          <div className="eyebrow" style={{ marginBottom: 12 }}>Portico</div>
          <h1 className="page-title">Enter your access token</h1>
          <p className="page-sub">
            RBAC is enabled for this console. Paste the token your admin gave you — it decides
            whether you can view, operate, or administer this instance.
          </p>
        </div>
        <div className="rise rise-2">
          <LoginForm />
        </div>
      </div>
    </>
  );
}
