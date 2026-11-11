import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Providers } from "@/components/providers";
import { ThemedToaster } from "@/components/theme";
import { THEME_COOKIE, themeBootScript } from "@/lib/prefs";
import "./globals.css";

export const metadata: Metadata = {
  title: "elevate",
  description: "Keeps your repos current with what actually works: verified techniques, proposed as draft PRs.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get(THEME_COOKIE)?.value === "light" ? "light" : "dark";
  return (
    <html lang="en" className={theme} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
        <ThemedToaster />
      </body>
    </html>
  );
}
