import type { Metadata } from "next";
import { Toaster } from "sonner";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "elevate",
  description: "Keeps your repos current with what actually works: verified techniques, proposed as draft PRs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
        <Toaster theme="dark" position="bottom-right" toastOptions={{ className: "!bg-panel !border-line-strong !text-fg" }} />
      </body>
    </html>
  );
}
