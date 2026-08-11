import { revalidatePath } from "next/cache";
import { promote } from "@/lib/api";

/**
 * Tier 0 -> Tier 1, with the cost stated before the click.
 *
 * Promotion is cheap in every respect except one: the app's Firestore data does
 * not follow on its own. That is the whole content of this component — the
 * buttons are two lines, and the rest is making sure the choice between copying
 * the data and leaving it is made deliberately rather than by whichever button
 * happened to be nearer.
 */
export function PromotePanel({ appId, tier }: { appId: string; tier: string }) {
  async function act(formData: FormData): Promise<void> {
    "use server";
    const id = String(formData.get("appId"));
    const mode = formData.get("mode") === "migrate" ? "migrate" : "reset";
    await promote(id, mode);
    revalidatePath(`/apps/${id}`);
  }

  if (tier === "dedicated") {
    return (
      <p className="sub">
        This app owns its Firebase project. Its users, data, rules and quotas are
        entirely its own.
      </p>
    );
  }

  return (
    <div className="card health">
      <div style={{ maxWidth: 460 }}>
        <strong>Pooled backend</strong>
        <p className="sub" style={{ margin: "4px 0 0" }}>
          Shares a Firebase project with other apps, with its own tenant and
          database. Promoting gives it a project of its own — the installed app
          picks the new backend up on its next launch, with no rebuild.{" "}
          <strong>The app&rsquo;s Firestore data does not follow on its own</strong> —
          copy it across, or promote knowing its users&rsquo; existing documents
          stay behind in the pool.
        </p>
      </div>

      <form action={act} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input type="hidden" name="appId" value={appId} />
        {/* Two buttons rather than a checkbox: the choice is consequential and
            asymmetric, so each option says what it does on its own face. */}
        <button type="submit" name="mode" value="migrate" className="primary">
          Promote &amp; copy data
        </button>
        <button type="submit" name="mode" value="reset" className="danger">
          Promote, start fresh
        </button>
      </form>
    </div>
  );
}
