import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    apiToken?: string;
    user?: {
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role?: string;
    };
  }

  interface User {
    role?: string;
    apiToken?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: string;
    apiToken?: string;
  }
}
