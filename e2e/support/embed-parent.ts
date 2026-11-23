import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for an app that shows SignuDoc's signing page in a frame. It
// serves one page that frames whatever ?src= says and keeps every message
// the frame posts to it in window.signudocMessages.

const PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Customer portal</title></head>
  <body>
    <h1>Customer portal</h1>
    <iframe id="signing" title="Sign your agreement" style="width:1200px;height:800px;border:0"></iframe>
    <script>
      window.signudocMessages = [];
      window.addEventListener("message", (event) => {
        window.signudocMessages.push({ data: event.data, origin: event.origin });
      });
      document.getElementById("signing").src =
        new URLSearchParams(location.search).get("src") || "about:blank";
    </script>
  </body>
</html>`;

export async function startEmbedParent() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    origin,
    pageFor: (src: string) =>
      `${origin}/?${new URLSearchParams({ src }).toString()}`,
  };
}
