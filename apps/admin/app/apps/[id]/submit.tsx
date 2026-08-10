import { revalidatePath } from "next/cache";
import { submitToPlay } from "@/lib/api";

/**
 * Putting the app in front of testers, as opposed to in front of its author.
 *
 * Separate from publishing on purpose. Publishing is routine — many times a
 * day, a minute each. This costs a build of its own, and it depends on a Play
 * listing a human had to create by hand, so it is a decision rather than a step.
 *
 * The prerequisites are stated rather than discovered. Play refuses API uploads
 * to an app whose first bundle has never been uploaded through its console, and
 * finding that out from a failed workflow ten minutes later is the worst way to
 * learn it.
 */
export function SubmitPanel({
  appId,
  submitting,
}: {
  appId: string;
  submitting: boolean;
}) {
  async function act(formData: FormData): Promise<void> {
    "use server";
    const id = String(formData.get("appId"));
    await submitToPlay(id);
    revalidatePath(`/apps/${id}`);
  }

  return (
    <div className="card health">
      <div style={{ maxWidth: 460 }}>
        <strong>Google Play — internal track</strong>
        <p className="sub" style={{ margin: "4px 0 0" }}>
          Builds an app bundle and pushes it to the internal testing track. About
          ten minutes, plus however long Play takes to process it. Needs a Play
          listing with this app&rsquo;s package name and one bundle already
          uploaded by hand — Play refuses API uploads to an app it has never
          seen.
        </p>
      </div>

      <form action={act}>
        <input type="hidden" name="appId" value={appId} />
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? "Submitting…" : "Submit to Play"}
        </button>
      </form>
    </div>
  );
}
