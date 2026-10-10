// The installed service worker consumes photo shares locally. This page is a
// bounded fallback for a first share before a worker controls the app.
import { readBoundedBody, RequestError } from '@/lib/store';
import { encodeBase64url } from '@/lib/data-utils';
export async function POST(request: Request) {
  try {
    if (request.headers.get('sec-fetch-site') === 'cross-site')
      throw new RequestError('Open TripTab to share a receipt.', 403);
    const origin = request.headers.get('origin');
    if (origin && origin !== 'null' && origin !== new URL(request.url).origin)
      throw new RequestError('Open TripTab to share a receipt.', 403);
    const bytes = await readBoundedBody(request, 11 * 1024 * 1024);
    const data = await new Response(bytes, {
      headers: { 'Content-Type': request.headers.get('content-type') ?? '' },
    }).formData();
    const files = data.getAll('receipt');
    const file = files[0];
    if (
      files.length !== 1 ||
      !(file instanceof File) ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      !file.size ||
      file.size > 10 * 1024 * 1024
    )
      throw new RequestError('Share one JPEG, PNG or WebP photo under 10 MB.');
    const encoded = encodeBase64url(new Uint8Array(await file.arrayBuffer()));
    const script = `const raw='${encoded}'.replace(/-/g,'+').replace(/_/g,'/'); const binary=atob(raw);const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));TripTabOffline.receivePhoto(new Blob([bytes],{type:'${file.type}'})).then(()=>location.replace('/')).catch(()=>document.querySelector('p').textContent='The photo could not be saved. Open TripTab and upload it again.');`;
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receive receipt</title><p>Preparing your shared receipt…</p><script src="/offline-store.js"></script><script>${script}</script></html>`,
      {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'private, no-store',
          'Referrer-Policy': 'no-referrer',
        },
      },
    );
  } catch (error) {
    return new Response(
      error instanceof RequestError
        ? error.message
        : 'Unable to receive this photo.',
      {
        status: error instanceof RequestError ? error.status : 400,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  }
}
