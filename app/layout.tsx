import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Engram — Context that connects", description: "Your team's memory, connected." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
