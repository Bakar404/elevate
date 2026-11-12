import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Providers } from "@/components/providers";
import { ThemedToaster } from "@/components/theme";
import { MOTION_COOKIE, THEME_COOKIE, themeBootScript } from "@/lib/prefs";
import "./globals.css";

export const metadata: Metadata = {
  title: "elevate",
  description: "Keeps your repos current with what actually works: verified techniques, proposed as draft PRs.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0d10" },
    { media: "(prefers-color-scheme: light)", color: "#f7f6f2" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const theme = jar.get(THEME_COOKIE)?.value === "light" ? "light" : "dark";
  const motion = jar.get(MOTION_COOKIE)?.value;
  return (
    <html lang="en" className={theme} data-motion={motion === "on" || motion === "off" ? motion : undefined} data-scroll-behavior="smooth" suppressHydrationWarning>
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
