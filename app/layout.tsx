import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "palantiny",
  description: "A local console for what's broadcasting around you.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
