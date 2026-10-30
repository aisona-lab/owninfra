import NextAuth from "next-auth";
import Cognito from "next-auth/providers/cognito";
import Credentials from "next-auth/providers/credentials";
import { cachedWebClient } from "@/lib/(generated)/cognito";
import { registry } from "@/lib/(generated)/registry";

const stub = process.env.OWNINFRA_AUTH_STUB === "1";
if (stub && process.env.NODE_ENV === "production") throw new Error("OWNINFRA_AUTH_STUB must not be set in production");

const seedRoles = (email: string) => registry.seedUsers.find((u) => u.email === email)?.roles ?? [];

// Deployed, USER_POOL_ID is set and the client comes from Cognito. Otherwise AUTH_COGNITO_ID/SECRET/ISSUER and AUTH_SECRET are read from env.
const { USER_POOL_ID, USER_POOL_CLIENT_NAME } = process.env;

export const { handlers, auth } = NextAuth(async () => {
  const web = !stub && USER_POOL_ID ? await cachedWebClient(USER_POOL_ID, USER_POOL_CLIENT_NAME ?? "web") : undefined;
  return {
    trustHost: true,
    secret: web?.authSecret ?? process.env.AUTH_SECRET ?? (stub ? "owninfra-local-dev-only" : undefined),
    session: { strategy: "jwt" },
    providers: stub
      ? [
          Credentials({
            name: "local seed user",
            credentials: { email: { label: `Email (${registry.seedUsers.map((u) => u.email).join(", ")})`, type: "email" } },
            authorize: (c) => {
              const email = String(c?.email ?? "");
              return registry.seedUsers.some((u) => u.email === email) ? { id: email, email, name: email } : null;
            },
          }),
        ]
      : [web ? Cognito({ clientId: web.clientId, clientSecret: web.clientSecret }) : Cognito],
    callbacks: {
      jwt({ token, user, profile }) {
        if (user?.email) token.roles = stub ? seedRoles(user.email) : ((profile?.["cognito:groups"] as string[] | undefined) ?? []);
        return token;
      },
      session({ session, token }) {
        return { ...session, roles: (token.roles as string[] | undefined) ?? [] };
      },
    },
  };
});
