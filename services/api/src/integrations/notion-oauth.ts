/**
 * Notion OAuth client (M6). Standard authorization-code flow against
 * api.notion.com; PKCE is not offered by Notion's integration OAuth, so the
 * defenses are: single-use hashed `state` bound to the initiating user
 * (CSRF), the client secret confined to the API process, and the exchanged
 * token encrypted before it touches the database.
 */

export interface NotionOAuthResult {
  accessToken: string;
  workspaceName: string | null;
  workspaceId: string | null;
  botId: string | null;
}

export interface NotionOAuthClient {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<NotionOAuthResult>;
}

export class NotionOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionOAuthError";
  }
}

export class HttpNotionOAuthClient implements NotionOAuthClient {
  constructor(
    private readonly cfg: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    },
  ) {}

  authorizeUrl(state: string): string {
    const url = new URL("https://api.notion.com/v1/oauth/authorize");
    url.searchParams.set("client_id", this.cfg.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("redirect_uri", this.cfg.redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<NotionOAuthResult> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.cfg.redirectUri,
      }),
    });
    if (!res.ok) {
      // Notion's error body may describe the request; never echo the code.
      throw new NotionOAuthError(`token exchange failed (${res.status})`);
    }
    const body = (await res.json()) as {
      access_token?: string;
      workspace_name?: string | null;
      workspace_id?: string | null;
      bot_id?: string | null;
    };
    if (!body.access_token) {
      throw new NotionOAuthError("token exchange returned no access_token");
    }
    return {
      accessToken: body.access_token,
      workspaceName: body.workspace_name ?? null,
      workspaceId: body.workspace_id ?? null,
      botId: body.bot_id ?? null,
    };
  }
}
