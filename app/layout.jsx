import "./globals.css";
export const metadata = {
 title: "Relay — Access, connected.",
 description: "Manage API permissions, budgets and agent sessions through an ENS permission tree.",
 icons: { icon: "/icon.svg" }
};
export default function RootLayout({ children }) {
 return <html lang="en"><head>
 <link rel="preconnect" href="https://fonts.googleapis.com" />
 <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
 <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Barlow+Condensed:wght@600;700;800;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
 </head><body>{children}</body></html>;
}
