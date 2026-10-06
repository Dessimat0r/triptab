import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_TRIPTAB_ENVIRONMENT === "staging" ? "TripTab Staging · Test expenses" : "TripTab · Holiday expenses",
  description: "Split the holiday, item by item.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "TripTab" },
  icons: { icon: "/favicon.svg", apple: "/icons/apple-touch-icon.png" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#4355db" },{ media: "(prefers-color-scheme: dark)", color: "#101626" }],
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
