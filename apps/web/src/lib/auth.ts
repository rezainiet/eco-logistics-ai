import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
        const res = await fetch(`${apiUrl}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(credentials),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { id: string; email: string; name?: string; role: string; token: string };
        return { id: data.id, email: data.email, name: data.name, role: data.role, apiToken: data.token };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.role = user.role;
        token.apiToken = user.apiToken;
      }
      // Silent refresh — the browser-side keeper calls
      // useSession().update({ apiToken }) after exchanging the
      // HttpOnly refresh cookie for a new access JWT. NextAuth surfaces
      // that as `trigger === "update"` plus the partial session object.
      // Without this branch the new token is dropped on the floor and
      // every subsequent tRPC call still uses the dead one.
      if (trigger === "update" && session && typeof session === "object") {
        const next = (session as { apiToken?: unknown }).apiToken;
        if (typeof next === "string" && next.length > 0) {
          token.apiToken = next;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.role = token.role;
      session.apiToken = token.apiToken;
      return session;
    },
  },
};
