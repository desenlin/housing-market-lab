import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Housing Market Lab | Desen Lin",
  description:
    "Interactive housing-market analysis for Orange and Los Angeles counties, with regional comparisons.",
  icons: {
    icon: `${process.env.GITHUB_PAGES === "true" ? "/housing-market-lab" : ""}/favicon.svg`,
    shortcut: `${process.env.GITHUB_PAGES === "true" ? "/housing-market-lab" : ""}/favicon.svg`,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
