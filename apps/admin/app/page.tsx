import Link from "next/link";
import { listApps } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function Home() {
  const apps = await listApps().catch(() => [] as Awaited<ReturnType<typeof listApps>>);

  const pooled = apps.filter((a) => a.backendTier === "pooled").length;
  const dedicated = apps.length - pooled;

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">
        Every app starts pooled. Dedicated projects consume GCP quota, so they are
        provisioned on publish.
      </p>

      <div className="card">
        <table>
          <tbody>
            <tr>
              <th>Apps</th>
              <td>{apps.length}</td>
            </tr>
            <tr>
              <th>Pooled (no GCP project)</th>
              <td>{pooled}</td>
            </tr>
            <tr>
              <th>Dedicated (consuming quota)</th>
              <td>{dedicated}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        <Link href="/apps">Browse all apps →</Link>
      </p>
    </>
  );
}
