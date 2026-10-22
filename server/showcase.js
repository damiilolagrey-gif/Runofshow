// Public pages vendors share as bragging rights: one review card, and a profile with every review.
// Rendered on the server so WhatsApp, Instagram and X link previews show the stars and the quote.
const { profileSlug } = require('./reviews');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const KIND = { 'ng-wedding': 'Wedding', corporate: 'Corporate event', conference: 'Conference' };
// Month and kind only: the event name usually carries the couple's names.
const occasion = (type, date) => `${KIND[type] || 'Event'} · ${new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`;

function page({ title, description, url, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(url)}">
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <meta name="theme-color" content="#5b2a6e">
  <link rel="stylesheet" href="/css/app.css">
</head>
<body>
  <main class="public-wrap stack">${body}
    <p class="muted small center">Verified through <a href="/">Run of Show</a>: written by the client from their private event page.</p>
  </main>
</body>
</html>`;
}

const reviewBlock = (r, { showOccasion = true } = {}) => `
  <figure class="review-card card">
    <div class="stars" aria-label="${r.rating} out of 5 stars">${stars(r.rating)}</div>
    ${r.body ? `<blockquote>“${esc(r.body)}”</blockquote>` : ''}
    <figcaption><strong>${esc(r.reviewer || 'The client')}</strong>${showOccasion ? `<span class="muted"> · ${esc(occasion(r.event_type, r.event_date))}</span>` : ''}</figcaption>
  </figure>`;

function mountShowcase(app, { reviews }) {
  const origin = (req) => `${req.protocol}://${req.get('host')}`;
  const notFound = (res) => res.status(404).send(page({ title: 'Not found · Run of Show', description: '', url: '', body: '<div class="card card-pad center">This link is no longer active.</div>' }));

  app.get('/review/:token', (req, res) => {
    const r = reviews.byToken(req.params.token);
    if (!r) return notFound(res);
    const slug = profileSlug(r.vendor_phone);
    const who = r.vendor_name === r.vendor_role ? r.vendor_name : `${r.vendor_name} · ${r.vendor_role}`;
    res.send(page({
      title: `${stars(r.rating)} for ${r.vendor_name}`,
      description: r.body ? `“${r.body.slice(0, 180)}” · ${r.reviewer || 'Verified client'}` : `${r.rating} out of 5 from a verified client.`,
      url: `${origin(req)}/review/${r.token}`,
      body: `
    <div class="head"><div class="pill ok">Verified review</div><h1>${esc(who)}</h1></div>
    ${reviewBlock(r)}
    ${slug ? `<a class="btn big" href="/pro/${slug}">See all of ${esc(r.vendor_name)}’s reviews</a>` : ''}`,
    }));
  });

  app.get('/pro/:slug', (req, res) => {
    const p = reviews.profile(req.params.slug);
    if (!p) return notFound(res);
    const count = p.reviews.length;
    res.send(page({
      title: `${p.name} · ${p.role}${count ? ` · ${p.average}★` : ''}`,
      description: count ? `${p.average} out of 5 from ${count} verified client review${count === 1 ? '' : 's'}. ${p.events} event${p.events === 1 ? '' : 's'} on Run of Show.` : `${p.events} event${p.events === 1 ? '' : 's'} on Run of Show.`,
      url: `${origin(req)}/pro/${req.params.slug}`,
      body: `
    <div class="head">
      <h1>${esc(p.name)}</h1><div class="muted">${esc(p.role)}</div>
      ${count ? `<div class="score"><span class="stars">${stars(Math.round(p.average))}</span> <strong>${p.average}</strong> <span class="muted">from ${count} verified review${count === 1 ? '' : 's'}</span></div>` : ''}
      <div class="muted small">${p.events} event${p.events === 1 ? '' : 's'} run on Run of Show</div>
    </div>
    ${p.reviews.map((r) => reviewBlock(r)).join('') || '<div class="card card-pad center muted">No reviews yet.</div>'}`,
    }));
  });
}

module.exports = { mountShowcase };
