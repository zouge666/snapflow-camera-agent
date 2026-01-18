import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { SiteFooter } from "./_components/site-footer";
import { SiteHeader } from "./_components/site-header";
import "./globals.css";
import { getPublicConfig } from "./public-config";

export const metadata: Metadata = {
  title: {
    default: "SnapFlow — Camera to action",
    template: "%s — SnapFlow",
  },
  description:
    "Turn a photo of meeting notes into traceable, human-approved action items.",
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f4f0e7",
};

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProps) {
  const { githubUrl } = getPublicConfig();

  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <SiteHeader githubUrl={githubUrl} />
        {children}
        <SiteFooter githubUrl={githubUrl} />
      </body>
    </html>
  );
}
