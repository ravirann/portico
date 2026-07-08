import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = resolve(process.cwd(), "../..");
const CONNECTORS_DIR = join(REPO_ROOT, "connectors");

export interface FlowSummary {
  key: string;
  file: string;
  description?: string;
  noBooking: boolean;
}
export interface ConnectorSummary {
  key: string;
  name: string;
  framework?: string;
  flows: FlowSummary[];
}

export function listConnectors(): ConnectorSummary[] {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(CONNECTORS_DIR).filter((d) => {
      try {
        return statSync(join(CONNECTORS_DIR, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  return dirs.map((dir) => {
    const base = join(CONNECTORS_DIR, dir);
    let target: any = {};
    try {
      target = parseYaml(readFileSync(join(base, "target.yaml"), "utf8")) ?? {};
    } catch {
      /* connector without a target.yaml */
    }
    const flows: FlowSummary[] = [];
    try {
      for (const f of readdirSync(join(base, "flows"))) {
        if (!f.endsWith(".flow.yaml")) continue;
        try {
          const flow: any = parseYaml(readFileSync(join(base, "flows", f), "utf8")) ?? {};
          flows.push({
            key: flow.key ?? f.replace(/\.flow\.yaml$/, ""),
            file: `connectors/${dir}/flows/${f}`,
            description: flow.description,
            noBooking: Boolean(flow.guard?.no_booking),
          });
        } catch {
          /* skip unparseable flow */
        }
      }
    } catch {
      /* no flows dir */
    }
    return {
      key: target.key ?? dir,
      name: target.name ?? dir,
      framework: target.framework,
      flows,
    };
  });
}
