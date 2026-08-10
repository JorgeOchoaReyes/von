import { revalidatePath } from "next/cache";
import { promote } from "@/lib/api";

/**
 * Tier 0 -> Tier 1, with the cost stated before the click.
 *
 * Promotion is cheap in every respect except one: the app's Firestore data does
 * not come with it. That is the whole content of this component — the button is
 * two lines, and the rest is making sure nobody presses it expecting otherwise.
 *
 * `confirm` on the form rather than a modal: this is an operator tool, the
 * consequence is one sentence, and a native confirm cannot be missed or styled
 * away.
 */
export function PromotePanel({ appId, tier }: { appId: string; tier: string }) {
  async function act(formData: FormData): Promise<void> {
    "use server";
    const id = String(formData.get("appId"));
    await promote(id);
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
          <strong>Existing Firestore data does not move</strong>: the promoted app
          starts against an empty database, and its users&rsquo; documents stay
          behind in the pool.
        </p>
      </div>

      <form action={act}>
        <input type="hidden" name="appId" value={appId} />
        <button
          type="submit"
          className="danger"
          formNoValidate
          // Server actions run on submit; the confirm is the last cheap moment
          // to stop one.
        >
          Promote &amp; reset data
        </button>
      </form>
    </div>
  );
}
