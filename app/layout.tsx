import type { Metadata } from "next";
import "leaflet/dist/leaflet.css";
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

const GOOGLE_ANALYTICS_ID = "G-MDGMSFPEH2";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <script async src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ANALYTICS_ID}`} />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GOOGLE_ANALYTICS_ID}');`,
          }}
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
