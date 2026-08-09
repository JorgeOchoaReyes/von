import { assertOk, TerminalError, type Driver } from "../driver.ts";

/**
 * Expo/EAS driver.
 *
 * Deliberate design choice: the platform owns **one** Expo organisation and
 * creates one *project* per generated app inside it. We do not create an Expo
 * account per user.
 *
 *   - Expo has no API to create accounts on someone's behalf, so per-user
 *     accounts would put a signup + email verification in the middle of the
 *     "describe your app" flow.
 *   - Builds are billed and queued per organisation, so one org gives us a
 *     single place to see and cap spend.
 *   - Store submission is the *only* thing that genuinely needs the customer's
 *     own identity, and that needs their Apple/Google developer account
 *     regardless — at which point we transfer the project to their org.
 */
export interface EasCtx {
  /** Expo access token (bot user in the platform org). */
  token(): Promise<string>;
  /** Expo account (org) id that owns generated projects. */
  accountId: string;
  accountName: string;
  /**
   * EAS project id of Von's **shell app** — the host binary that shell-mode
   * apps are delivered inside. Those apps do not get their own EAS project, so
   * their update channel is created on this one.
   *
   * Optional, because standalone is the default (docs/ARCHITECTURE.md §12) and
   * a deployment that never uses shell mode should not have to invent a project
   * id to boot. Required only when an app actually asks for shell delivery.
   */
  shellProjectId?: string;
}

async function graphql<T>(
  ctx: EasCtx,
  query: string,
  variables: Record<string, unknown>,
  context: string,
): Promise<T> {
  const token = await ctx.token();
  const res = await fetch("https://api.expo.dev/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  await assertOk(res, context);
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new TerminalError(`${context}: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new TerminalError(`${context}: empty response`);
  return body.data;
}

export interface EasProjectSpec {
  appId: string;
  /** Expo slug — must be unique within the account. */
  slug: string;
  displayName: string;
}

export interface EasProjectOutputs extends Record<string, unknown> {
  externalId: string;
  /** Goes into app.json as `extra.eas.projectId` (DEPLOY.md §4.2). */
  projectId: string;
  fullName: string;
}

export function easProjectDriver(ctx: EasCtx): Driver<EasProjectSpec, EasProjectOutputs> {
  return {
    kind: "eas.project",
    key: (s) => `eas.project:${s.appId}`,

    async read(spec) {
      const fullName = `@${ctx.accountName}/${spec.slug}`;
      const data = await graphql<{ app: { byFullName: { id: string } | null } }>(
        ctx,
        `query ($fullName: String!) {
           app { byFullName(fullName: $fullName) { id } }
         }`,
        { fullName },
        "lookup eas project",
      ).catch(() => null);

      const id = data?.app?.byFullName?.id;
      return id ? { externalId: id, projectId: id, fullName } : null;
    },

    async create(spec) {
      const data = await graphql<{ app: { createApp: { id: string } } }>(
        ctx,
        `mutation ($input: AppInput!) {
           app { createApp(appInput: $input) { id } }
         }`,
        {
          input: {
            accountId: ctx.accountId,
            projectName: spec.slug,
            displayName: spec.displayName,
            privacy: "UNLISTED",
          },
        },
        "create eas project",
      );

      return {
        externalId: data.app.createApp.id,
        projectId: data.app.createApp.id,
        fullName: `@${ctx.accountName}/${spec.slug}`,
      };
    },
  };
}

export interface EasChannelSpec {
  appId: string;
  easProjectId: string;
  /**
   * One channel per app per environment. For shell-delivered apps this is the
   * *only* isolation between tenants' bundles, so it must be unguessable-ish
   * and derived from the app id, never from a user-supplied name.
   */
  channelName: string;
}

export function easChannelDriver(
  ctx: EasCtx,
): Driver<EasChannelSpec, Record<string, unknown>> {
  return {
    kind: "eas.channel",
    key: (s) => `eas.channel:${s.appId}:${s.channelName}`,

    async read(spec) {
      const data = await graphql<{
        app: { byId: { updateChannelByName: { id: string } | null } };
      }>(
        ctx,
        `query ($appId: String!, $name: String!) {
           app { byId(appId: $appId) { updateChannelByName(name: $name) { id } } }
         }`,
        { appId: spec.easProjectId, name: spec.channelName },
        "lookup eas channel",
      ).catch(() => null);

      const id = data?.app?.byId?.updateChannelByName?.id;
      return id ? { externalId: id } : null;
    },

    async create(spec) {
      const data = await graphql<{
        updateChannel: { createUpdateChannelForApp: { id: string } };
      }>(
        ctx,
        `mutation ($appId: ID!, $name: String!) {
           updateChannel {
             createUpdateChannelForApp(appId: $appId, name: $name) { id }
           }
         }`,
        { appId: spec.easProjectId, name: spec.channelName },
        "create eas channel",
      );
      return { externalId: data.updateChannel.createUpdateChannelForApp.id };
    },
  };
}
