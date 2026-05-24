"use client";
import Script from "next/script";

export default function DocsPage() {
  return (
    <>
      {/* Swagger UI CSS from CDN */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link
        rel="stylesheet"
        href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"
      />

      {/* Reset app global styles so Swagger UI looks correct */}
      <style>{`
        body { background: #fafafa; margin: 0; padding: 0; }
        #swagger-root { min-height: 100vh; }
      `}</style>

      <div id="swagger-root">
        <div id="swagger-ui" />
      </div>

      {/* Load Swagger UI bundle then initialise */}
      <Script
        src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"
        strategy="afterInteractive"
        onLoad={() => {
          window.SwaggerUIBundle({
            url: "/API.yaml",
            dom_id: "#swagger-ui",
            deepLinking: true,
            tryItOutEnabled: true,
            requestInterceptor: (req) => {
              // Pre-fill server URL so "Try it out" defaults to localhost
              return req;
            },
          });
        }}
      />
    </>
  );
}
