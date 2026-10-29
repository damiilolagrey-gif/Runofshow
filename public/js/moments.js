/* global Ros, RosNav, RosSection */
// The hosts' album of what guests shared, the upload QR code, and the link to the live wall.
(() => {
  const $ = (id) => document.getElementById(id);
  const file = (m, download) => `${RosNav.api}/moments/${m.id}/file${download ? '?download=1' : ''}`;
  let data = null;
  let filter = 'all';
  let current = null;

  function render() {
    const s = data.stats;
    $('s-photos').textContent = s.photos;
    $('s-videos').textContent = s.videos;
    $('s-guests').textContent = s.guests;
    const pct = s.limit_bytes ? Math.min(100, Math.round((s.bytes / s.limit_bytes) * 100)) : 0;
    $('s-space').textContent = `${pct}%`;
    $('s-space-l').textContent = `Album space used (${Math.round(s.bytes / 1048576)} of ${Math.round(s.limit_bytes / 1048576)} MB)`;

    $('open').checked = data.open;
    $('qr').src = `${RosNav.api}/moments/qr.svg`;
    $('qr-dl').href = `${RosNav.api}/moments/qr.svg`;
    $('wall').href = data.wall_url;
    $('wa').href = Ros.waLink('', `Share your photos and videos from today with us here: ${data.upload_url}`);

    for (const b of document.querySelectorAll('#filters [data-f]')) b.classList.toggle('ghost', b.dataset.f !== filter);
    const list = data.items.filter((m) => (filter === 'all' ? true : filter === 'hidden' ? m.hidden : m.kind === filter));
    $('grid').innerHTML = list.map((m) => `<button type="button" class="moment${m.hidden ? ' is-hidden' : ''}" data-id="${m.id}">
        ${m.kind === 'video' ? `<video src="${file(m)}#t=0.1" muted playsinline preload="metadata"></video><span class="moment-badge">▶ Video</span>` : `<img src="${file(m)}" alt="" loading="lazy">`}
        ${m.hidden ? '<span class="moment-badge hidden-badge">Hidden</span>' : ''}
        <span class="moment-who">${Ros.esc(m.guest_name || 'A guest')}</span>
      </button>`).join('')
      || `<p class="muted">${data.items.length ? 'Nothing here.' : 'Nothing yet. When guests scan the code, what they send shows up here.'}</p>`;
  }

  function view(m) {
    current = m;
    $('view-media').innerHTML = m.kind === 'video' ? `<video src="${file(m)}" controls autoplay playsinline></video>` : `<img src="${file(m)}" alt="">`;
    $('view-who').textContent = `${m.guest_name || 'A guest'} · ${Ros.timeAgo(m.created_at)}`;
    $('view-hide').textContent = m.hidden ? 'Show on wall' : 'Hide from wall';
    $('view-dl').href = file(m, true);
    $('view-dlg').showModal();
  }
  const closeView = () => { $('view-media').innerHTML = ''; $('view-dlg').close(); };

  async function load() {
    data = await RosSection.api('GET', '/moments');
    render();
  }
  RosSection.start({ section: 'moments', topics: ['moments', 'settings'], load });

  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (b) { filter = b.dataset.f; render(); }
  });
  $('grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) view(data.items.find((m) => m.id === Number(b.dataset.id)));
  });
  $('open').addEventListener('change', async (e) => {
    try {
      await RosSection.api('PATCH', '/moments-settings', { open: e.target.checked });
      Ros.toast(e.target.checked ? 'Guests can share again' : 'Uploads closed');
    } finally { load(); }
  });
  $('copy').addEventListener('click', () => Ros.copy(data.upload_url));
  $('view-close').addEventListener('click', closeView);
  $('view-dlg').addEventListener('close', () => { $('view-media').innerHTML = ''; });
  $('view-hide').addEventListener('click', async () => {
    await RosSection.api('PATCH', `/moments/${current.id}`, { hidden: !current.hidden });
    closeView();
    load();
  });
  $('view-del').addEventListener('click', async () => {
    if (!confirm('Delete this for good? It also leaves the wall.')) return;
    await RosSection.api('DELETE', `/moments/${current.id}`);
    closeView();
    load();
  });
})();
